const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { deleteVectors, uploadVectors } = require('~/server/services/Files/VectorDB/crud');

const MAX_KNOWLEDGE_UPLOAD_BYTES = 20 * 1024 * 1024;

function boundedStream(maxBytes) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error(`Knowledge document exceeds the ${maxBytes} byte limit`));
        return;
      }
      callback(null, chunk);
    },
  });
}

function safeError(error) {
  return (error instanceof Error ? error.message : 'Knowledge document ingestion failed').slice(
    0,
    4000,
  );
}

function createKnowledgeDocumentIngestionService(overrides = {}) {
  const database = overrides.db ?? db;
  const getStrategies = overrides.getStrategyFunctions ?? getStrategyFunctions;
  const upload = overrides.uploadVectors ?? uploadVectors;
  const removeVectors = overrides.deleteVectors ?? deleteVectors;

  return async function ingestKnowledgeDocument(knowledgeBaseId, input, req) {
    if (!input.file_id || !req?.user?.id) return null;
    const owner = req.user._id ?? req.user.id;
    const file = await database.findFileById(input.file_id, { user: owner });
    if (!file) return null;

    const document = await database.createKnowledgeDocument(
      knowledgeBaseId,
      {
        ...input,
        file_id: file.file_id,
        name: file.filename,
        mime_type: file.type,
        bytes: file.bytes,
        source_type: 'upload',
      },
      req.user.tenantId,
    );
    if (!document) return null;

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'librechat-kb-upload-'));
    const tempFilename =
      path.basename(file.filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'document';
    const tempPath = path.join(tempDir, tempFilename);
    try {
      if (file.bytes > MAX_KNOWLEDGE_UPLOAD_BYTES) {
        throw new Error(`Knowledge document exceeds the ${MAX_KNOWLEDGE_UPLOAD_BYTES} byte limit`);
      }
      const { getDownloadStream } = getStrategies(file.source);
      if (!getDownloadStream) {
        throw new Error(`Knowledge ingestion is not supported for ${file.source} files`);
      }
      const downloadPath = file.storageKey ?? file.filepath;
      const stream = await getDownloadStream(req, downloadPath);
      await pipeline(
        stream,
        boundedStream(MAX_KNOWLEDGE_UPLOAD_BYTES),
        fs.createWriteStream(tempPath, { flags: 'wx' }),
      );
      await upload({
        req,
        file: {
          path: tempPath,
          originalname: file.filename,
          mimetype: file.type,
          size: file.bytes,
        },
        file_id: file.file_id,
        entity_id: knowledgeBaseId,
      });
      return await database.updateKnowledgeDocument(knowledgeBaseId, document._id.toString(), {
        status: 'ready',
        error: null,
      });
    } catch (error) {
      await Promise.allSettled([
        removeVectors(req, { file_id: file.file_id, embedded: true }, knowledgeBaseId),
      ]);
      logger.error('[knowledge-documents] Existing file ingestion failed', error);
      return await database.updateKnowledgeDocument(knowledgeBaseId, document._id.toString(), {
        status: 'failed',
        error: safeError(error),
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  };
}

const ingestKnowledgeDocument = createKnowledgeDocumentIngestionService();

module.exports = {
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  createKnowledgeDocumentIngestionService,
  ingestKnowledgeDocument,
};
