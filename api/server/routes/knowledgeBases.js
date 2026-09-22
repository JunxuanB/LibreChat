const express = require('express');
const { createKnowledgeHandlers } = require('@librechat/api');
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

module.exports = router;
