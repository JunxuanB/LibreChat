const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  KnowledgeSourceSyncRunner,
  createDefaultKnowledgeConnectorRegistry,
  validateEndpointURL,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { deleteVectors, uploadVectors } = require('~/server/services/Files/VectorDB/crud');

const MAX_CONNECTOR_FILE_BYTES = 20 * 1024 * 1024;

const asString = (value) => value?.toString?.() ?? String(value);

function itemBuffer(item) {
  if (item.content != null && item.binaryContent != null) {
    throw new Error('Connector items must provide either text or binary content, not both');
  }
  const content =
    item.binaryContent != null
      ? Buffer.from(item.binaryContent)
      : Buffer.from(item.content ?? '', 'utf8');
  if (content.byteLength > MAX_CONNECTOR_FILE_BYTES) {
    throw new Error(`Connector item exceeds the ${MAX_CONNECTOR_FILE_BYTES} byte limit`);
  }
  return content;
}

function normalizedTitle(title) {
  const value = String(title).replace(/\0/g, '').trim();
  return (value || 'Untitled connector document').slice(0, 255);
}

function tempFilename(filename) {
  return path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'document.txt';
}

function createKnowledgeSourceSyncService(overrides = {}) {
  const database = overrides.db ?? db;
  const registry = overrides.connectorRegistry ?? createDefaultKnowledgeConnectorRegistry();
  const upload = overrides.uploadVectors ?? uploadVectors;
  const removeVectors = overrides.deleteVectors ?? deleteVectors;
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const assertSafeUrl =
    overrides.assertSafeUrl ??
    ((url) => validateEndpointURL(url.toString(), 'knowledge source connector'));
  const activeSources = new Map();

  const loadSource = async (knowledgeBaseId, sourceId) => {
    const source = await database.getKnowledgeSourceForSync(knowledgeBaseId, sourceId);
    if (!source) return null;
    activeSources.set(sourceId, source);
    return {
      id: asString(source._id),
      knowledgeBaseId: asString(source.knowledgeBaseId),
      type: source.type,
      config: source.config ?? {},
      connectionId: source.connectionId ? asString(source.connectionId) : undefined,
      cursor: source.cursor,
      syncAttempts: source.syncAttempts,
    };
  };

  const requestFor = (source) => ({
    user: { id: asString(source.owner), _id: source.owner },
  });

  const cleanupFile = async (source, fileId, knowledgeBaseId) => {
    if (!fileId) return;
    const req = requestFor(source);
    await removeVectors(req, { file_id: fileId, embedded: true }, knowledgeBaseId);
    await database.deleteFile(fileId);
  };

  const upsertDocument = async (key, item) => {
    const source = activeSources.get(key.sourceId);
    if (!source) throw new Error('Knowledge source sync context is unavailable');
    if (!item.externalId || item.externalId.length > 512) {
      throw new Error('Connector external ID must contain between 1 and 512 characters');
    }
    const content = itemBuffer(item);
    const revision = item.revision ?? crypto.createHash('sha256').update(content).digest('hex');
    const documentKey = { ...key, externalId: item.externalId };
    const current = await database.findKnowledgeDocumentBySource(documentKey);
    if (current?.revision === revision && current.file_id) return;

    const fileId = crypto.randomUUID();
    const title = normalizedTitle(item.title);
    const mimeType =
      item.mimeType ?? (item.binaryContent ? 'application/octet-stream' : 'text/plain');
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'librechat-kb-'));
    const tempPath = path.join(tempDir, tempFilename(title));
    let createdFile = false;
    try {
      await fsp.writeFile(tempPath, content, { flag: 'wx' });
      const embedded = await upload({
        req: requestFor(source),
        file: {
          path: tempPath,
          originalname: title,
          mimetype: mimeType,
          size: content.byteLength,
        },
        file_id: fileId,
        entity_id: key.knowledgeBaseId,
      });
      const file = await database.createFile(
        {
          ...embedded,
          user: source.owner,
          tenantId: source.tenantId,
          file_id: fileId,
          filename: title,
          bytes: content.byteLength,
          type: mimeType,
          source: 'vectordb',
          object: 'file',
          embedded: true,
          usage: 0,
        },
        true,
      );
      if (!file) throw new Error('Failed to persist connector file');
      createdFile = true;
      await database.upsertKnowledgeDocumentBySource({
        ...documentKey,
        file_id: fileId,
        name: title,
        mime_type: mimeType,
        bytes: content.byteLength,
        canonical_url: item.canonicalUrl,
        revision,
        metadata: item.metadata,
        tenantId: source.tenantId,
      });
    } catch (error) {
      await Promise.allSettled([
        removeVectors(requestFor(source), { file_id: fileId, embedded: true }, key.knowledgeBaseId),
        ...(createdFile ? [database.deleteFile(fileId)] : []),
      ]);
      throw error;
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }

    if (current?.file_id && current.file_id !== fileId) {
      try {
        await cleanupFile(source, current.file_id, key.knowledgeBaseId);
      } catch (error) {
        logger.warn('[knowledge-sync] Failed to clean replaced connector file', error);
      }
    }
  };

  const deleteDocument = async (key, externalId) => {
    const source = activeSources.get(key.sourceId);
    if (!source) throw new Error('Knowledge source sync context is unavailable');
    const documentKey = { ...key, externalId };
    const current = await database.findKnowledgeDocumentBySource(documentKey);
    if (!current) return;
    if (current.file_id) await cleanupFile(source, current.file_id, key.knowledgeBaseId);
    await database.deleteKnowledgeDocumentBySource(documentKey);
  };

  const reconcileDocuments = async (key, retainedExternalIds, signal) => {
    const retained = new Set(retainedExternalIds);
    const existing = await database.findKnowledgeDocumentsBySourceId(
      key.knowledgeBaseId,
      key.sourceId,
    );
    let deleted = 0;
    for (const document of existing) {
      signal?.throwIfAborted();
      if (!document.source_id || retained.has(document.source_id)) continue;
      await deleteDocument(key, document.source_id, signal);
      deleted += 1;
    }
    return deleted;
  };

  const runner = new KnowledgeSourceSyncRunner({
    loadSource,
    loadCredentials: (connectionId) => database.getKnowledgeConnectionSecrets(connectionId),
    connectorRegistry: registry,
    connectorContext: { fetch: fetchImpl, assertSafeUrl },
    upsertDocument,
    deleteDocument,
    reconcileDocuments,
    updateSourceState: (sourceId, state) =>
      database.updateKnowledgeSourceSyncState(sourceId, state),
  });

  return {
    runner,
    async syncKnowledgeSource(knowledgeBaseId, sourceId) {
      try {
        await runner.run(knowledgeBaseId, sourceId);
        return database.getKnowledgeSourceForSync(knowledgeBaseId, sourceId);
      } finally {
        activeSources.delete(sourceId);
      }
    },
  };
}

const knowledgeSourceSyncService = createKnowledgeSourceSyncService();

module.exports = {
  MAX_CONNECTOR_FILE_BYTES,
  createKnowledgeSourceSyncService,
  syncKnowledgeSource: knowledgeSourceSyncService.syncKnowledgeSource,
};
