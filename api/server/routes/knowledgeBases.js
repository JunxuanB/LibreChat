const express = require('express');
const { createKnowledgeHandlers, createKnowledgeSourceHandlers } = require('@librechat/api');
const { PermissionBits, ResourceType } = require('librechat-data-provider');
const { requireJwtAuth, canAccessResource } = require('~/server/middleware');
const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
  grantPermission,
} = require('~/server/services/PermissionService');
const db = require('~/models');

const router = express.Router();
const handlers = createKnowledgeHandlers({
  createKnowledgeBase: db.createKnowledgeBase,
  getKnowledgeBaseById: db.getKnowledgeBaseById,
  listKnowledgeBases: db.listKnowledgeBases,
  updateKnowledgeBase: db.updateKnowledgeBase,
  deleteKnowledgeBase: db.deleteKnowledgeBase,
  createKnowledgeDocument: db.createKnowledgeDocument,
  listKnowledgeDocuments: db.listKnowledgeDocuments,
  updateKnowledgeDocument: db.updateKnowledgeDocument,
  deleteKnowledgeDocument: db.deleteKnowledgeDocument,
  findAccessibleResources,
  findPubliclyAccessibleResources,
  grantPermission,
});
const sourceHandlers = createKnowledgeSourceHandlers({
  listKnowledgeSources: db.listKnowledgeSources,
  createKnowledgeSource: db.createKnowledgeSource,
  updateKnowledgeSource: db.updateKnowledgeSource,
  deleteKnowledgeSource: db.deleteKnowledgeSource,
  // Follow-up connector registry wiring: connectorRegistry: createDefaultKnowledgeConnectorRegistry()
});

const canAccess = (requiredPermission) =>
  canAccessResource({
    resourceType: ResourceType.KNOWLEDGE_BASE,
    requiredPermission,
    resourceIdParam: 'id',
    idResolver: db.getKnowledgeBaseById,
  });

router.use(requireJwtAuth);
router.get('/', handlers.list);
router.post('/', handlers.create);
router.get('/connectors', sourceHandlers.connectors);
router.get('/:id', canAccess(PermissionBits.VIEW), handlers.get);
router.patch('/:id', canAccess(PermissionBits.EDIT), handlers.patch);
router.delete('/:id', canAccess(PermissionBits.DELETE), handlers.remove);
router.get('/:id/documents', canAccess(PermissionBits.VIEW), handlers.listDocuments);
router.post('/:id/documents', canAccess(PermissionBits.EDIT), handlers.createDocument);
router.patch('/:id/documents/:documentId', canAccess(PermissionBits.EDIT), handlers.patchDocument);
router.delete(
  '/:id/documents/:documentId',
  canAccess(PermissionBits.EDIT),
  handlers.removeDocument,
);
router.get('/:id/sources', canAccess(PermissionBits.VIEW), sourceHandlers.list);
router.post('/:id/sources', canAccess(PermissionBits.EDIT), sourceHandlers.create);
router.patch('/:id/sources/:sourceId', canAccess(PermissionBits.EDIT), sourceHandlers.patch);
router.delete('/:id/sources/:sourceId', canAccess(PermissionBits.EDIT), sourceHandlers.remove);
router.post('/:id/sources/:sourceId/sync', canAccess(PermissionBits.EDIT), sourceHandlers.sync);

module.exports = router;
