const crypto = require('crypto');
const db = require('~/models');
const { deleteVectors } = require('~/server/services/Files/VectorDB/crud');

const CLEANUP_LEASE_MS = 5 * 60 * 1000;

class KnowledgeSourceCleanupInProgressError extends Error {
  constructor() {
    super('Knowledge source synchronization is in progress');
    this.name = 'KnowledgeSourceCleanupInProgressError';
    this.code = 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS';
  }
}

function createKnowledgeCleanupService(overrides = {}) {
  const database = overrides.db ?? db;
  const removeVectors = overrides.deleteVectors ?? deleteVectors;
  const now = overrides.now ?? (() => new Date());
  const createToken = overrides.createToken ?? (() => crypto.randomUUID());

  const withSourceLease = async (knowledgeBaseId, sourceId, operation) => {
    const source = await database.getKnowledgeSourceForSync(knowledgeBaseId, sourceId);
    if (!source) return operation(() => undefined);

    const token = createToken();
    const lease = {
      knowledgeBaseId,
      sourceId,
      tenantId: source.tenantId,
      token,
    };
    const acquiredAt = now();
    const acquired = await database.acquireKnowledgeSourceSyncLease({
      ...lease,
      now: acquiredAt,
      expiresAt: new Date(acquiredAt.getTime() + CLEANUP_LEASE_MS),
    });
    if (!acquired) throw new KnowledgeSourceCleanupInProgressError();

    let leaseLost = false;
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing || leaseLost) return;
      renewing = true;
      try {
        const heartbeatAt = now();
        const renewed = await database.renewKnowledgeSourceSyncLease({
          ...lease,
          now: heartbeatAt,
          expiresAt: new Date(heartbeatAt.getTime() + CLEANUP_LEASE_MS),
        });
        leaseLost = !renewed;
      } catch {
        leaseLost = true;
      } finally {
        renewing = false;
      }
    }, CLEANUP_LEASE_MS / 3);
    heartbeat.unref?.();

    try {
      const result = await operation(() => {
        if (leaseLost) throw new KnowledgeSourceCleanupInProgressError();
      });
      if (leaseLost) throw new KnowledgeSourceCleanupInProgressError();
      return result;
    } finally {
      clearInterval(heartbeat);
      await database.releaseKnowledgeSourceSyncLease(lease).catch(() => false);
    }
  };

  const cleanupDocument = async (knowledgeBaseId, document, req) => {
    if (!document.file_id) return;
    if (!req?.user?.id) throw new Error('Authentication is required for knowledge cleanup');
    await removeVectors(req, { file_id: document.file_id, embedded: true }, knowledgeBaseId);
    if (document.knowledgeSourceId) {
      await database.deleteFile(document.file_id);
    }
  };

  return {
    async deleteKnowledgeDocument(knowledgeBaseId, documentId, req) {
      const document = await database.getKnowledgeDocumentById(knowledgeBaseId, documentId);
      if (!document) return { deleted: false };
      const remove = async (assertLease = () => undefined) => {
        await cleanupDocument(knowledgeBaseId, document, req);
        assertLease();
        return database.deleteKnowledgeDocument(knowledgeBaseId, documentId);
      };
      return document.knowledgeSourceId
        ? withSourceLease(knowledgeBaseId, document.knowledgeSourceId.toString(), remove)
        : remove();
    },

    async deleteKnowledgeSource(knowledgeBaseId, sourceId, req) {
      return withSourceLease(knowledgeBaseId, sourceId, async (assertLease) => {
        const documents = await database.findKnowledgeDocumentsBySourceId(
          knowledgeBaseId,
          sourceId,
        );
        for (const document of documents) {
          await cleanupDocument(knowledgeBaseId, document, req);
          assertLease();
          await database.deleteKnowledgeDocument(knowledgeBaseId, document._id.toString());
        }
        assertLease();
        return database.deleteKnowledgeSource(knowledgeBaseId, sourceId);
      });
    },

    async deleteKnowledgeBase(knowledgeBaseId, req) {
      const sources = await database.listKnowledgeSources(knowledgeBaseId);
      const orderedSources = [...sources].sort((a, b) =>
        a._id.toString().localeCompare(b._id.toString()),
      );
      const withAllLeases = (index, operation) => {
        if (index === orderedSources.length) return operation();
        return withSourceLease(knowledgeBaseId, orderedSources[index]._id.toString(), () =>
          withAllLeases(index + 1, operation),
        );
      };
      return withAllLeases(0, async () => {
        const documents = await database.findKnowledgeDocumentsForCleanup(knowledgeBaseId);
        for (const document of documents) {
          await cleanupDocument(knowledgeBaseId, document, req);
        }
        return database.deleteKnowledgeBase(knowledgeBaseId);
      });
    },
  };
}

const knowledgeCleanupService = createKnowledgeCleanupService();

module.exports = {
  KnowledgeSourceCleanupInProgressError,
  createKnowledgeCleanupService,
  deleteKnowledgeBase: knowledgeCleanupService.deleteKnowledgeBase,
  deleteKnowledgeDocument: knowledgeCleanupService.deleteKnowledgeDocument,
  deleteKnowledgeSource: knowledgeCleanupService.deleteKnowledgeSource,
};
