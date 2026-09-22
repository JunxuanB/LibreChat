const express = require('express');
const {
  createDefaultKnowledgeConnectorRegistry,
  createKnowledgeHandlers,
  createKnowledgeSourceHandlers,
  generateCheckAccess,
} = require('@librechat/api');
const {
  PermissionBits,
  PermissionTypes,
  Permissions,
  ResourceType,
} = require('librechat-data-provider');
const { requireJwtAuth, canAccessResource } = require('~/server/middleware');
const {
  findAccessibleResources,
  findPubliclyAccessibleResources,
  grantPermission,
} = require('~/server/services/PermissionService');
const db = require('~/models');
const { enqueueKnowledgeSourceSync } = require('~/server/services/Knowledge/jobs');
const { ingestKnowledgeDocument } = require('~/server/services/Knowledge/documents');
const {
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  deleteKnowledgeSource,
} = require('~/server/services/Knowledge/cleanup');

const router = express.Router();
const handlers = createKnowledgeHandlers({
  canAccessFile: async ({ fileId, userId }) => {
    const files = await db.getFiles({ file_id: fileId, user: userId }, null, { _id: 1 });
    return files.length > 0;
  },
  createKnowledgeBase: db.createKnowledgeBase,
  getKnowledgeBaseById: db.getKnowledgeBaseById,
  listKnowledgeBases: db.listKnowledgeBases,
  updateKnowledgeBase: db.updateKnowledgeBase,
  deleteKnowledgeBase,
  createKnowledgeDocument: (knowledgeBaseId, input, _tenantId, req) =>
    ingestKnowledgeDocument(knowledgeBaseId, input, req),
  listKnowledgeDocuments: db.listKnowledgeDocuments,
  updateKnowledgeDocument: db.updateKnowledgeDocument,
  deleteKnowledgeDocument,
  findAccessibleResources,
  findPubliclyAccessibleResources,
  grantPermission,
});
const sourceHandlers = createKnowledgeSourceHandlers({
  connectorRegistry: createDefaultKnowledgeConnectorRegistry(),
  listKnowledgeSources: db.listKnowledgeSources,
  createKnowledgeSource: db.createKnowledgeSource,
  updateKnowledgeSource: db.updateKnowledgeSource,
  deleteKnowledgeSource,
  syncKnowledgeSource: enqueueKnowledgeSourceSync,
});

const canAccess = (requiredPermission) =>
  canAccessResource({
    resourceType: ResourceType.KNOWLEDGE_BASE,
    requiredPermission,
    resourceIdParam: 'id',
    idResolver: db.getKnowledgeBaseById,
  });
const checkKnowledgeUse = generateCheckAccess({
  permissionType: PermissionTypes.KNOWLEDGE_BASES,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});
const checkKnowledgeCreate = generateCheckAccess({
  permissionType: PermissionTypes.KNOWLEDGE_BASES,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName: db.getRoleByName,
});

router.use(requireJwtAuth);
router.use(checkKnowledgeUse);
router.get('/', handlers.list);
router.post('/', checkKnowledgeCreate, handlers.create);
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
