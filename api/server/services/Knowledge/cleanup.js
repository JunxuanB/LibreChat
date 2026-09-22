const db = require('~/models');
const { deleteVectors } = require('~/server/services/Files/VectorDB/crud');

function createKnowledgeCleanupService(overrides = {}) {
  const database = overrides.db ?? db;
  const removeVectors = overrides.deleteVectors ?? deleteVectors;

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
      await cleanupDocument(knowledgeBaseId, document, req);
      return database.deleteKnowledgeDocument(knowledgeBaseId, documentId);
    },

    async deleteKnowledgeSource(knowledgeBaseId, sourceId, req) {
      const documents = await database.findKnowledgeDocumentsBySourceId(knowledgeBaseId, sourceId);
      for (const document of documents) {
        await cleanupDocument(knowledgeBaseId, document, req);
        await database.deleteKnowledgeDocument(knowledgeBaseId, document._id.toString());
      }
      return database.deleteKnowledgeSource(knowledgeBaseId, sourceId);
    },

    async deleteKnowledgeBase(knowledgeBaseId, req) {
      const documents = await database.findKnowledgeDocumentsForCleanup(knowledgeBaseId);
      for (const document of documents) {
        await cleanupDocument(knowledgeBaseId, document, req);
      }
      return database.deleteKnowledgeBase(knowledgeBaseId);
    },
  };
}

const knowledgeCleanupService = createKnowledgeCleanupService();

module.exports = {
  createKnowledgeCleanupService,
  deleteKnowledgeBase: knowledgeCleanupService.deleteKnowledgeBase,
  deleteKnowledgeDocument: knowledgeCleanupService.deleteKnowledgeDocument,
  deleteKnowledgeSource: knowledgeCleanupService.deleteKnowledgeSource,
};
