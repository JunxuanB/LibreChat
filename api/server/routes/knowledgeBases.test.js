const mockKnowledgeHandlers = {
  list: jest.fn((_req, res) => res.status(200).json({ route: 'list' })),
  create: jest.fn((_req, res) => res.status(201).json({ route: 'create' })),
  get: jest.fn((_req, res) => res.status(200).json({ route: 'get' })),
  patch: jest.fn((_req, res) => res.status(200).json({ route: 'patch' })),
  remove: jest.fn((_req, res) => res.status(200).json({ route: 'remove' })),
  listDocuments: jest.fn((_req, res) => res.status(200).json({ route: 'listDocuments' })),
  createDocument: jest.fn((_req, res) => res.status(201).json({ route: 'createDocument' })),
  patchDocument: jest.fn((_req, res) => res.status(200).json({ route: 'patchDocument' })),
  removeDocument: jest.fn((_req, res) => res.status(200).json({ route: 'removeDocument' })),
};
const mockSourceHandlers = {
  connectors: jest.fn((_req, res) => res.status(200).json({ route: 'connectors' })),
  list: jest.fn((_req, res) => res.status(200).json({ route: 'listSources' })),
  create: jest.fn((_req, res) => res.status(201).json({ route: 'createSource' })),
  patch: jest.fn((_req, res) => res.status(200).json({ route: 'patchSource' })),
  remove: jest.fn((_req, res) => res.status(200).json({ route: 'removeSource' })),
  sync: jest.fn((_req, res) => res.status(200).json({ route: 'syncSource' })),
};
let mockKnowledgeDeps;
let mockSourceDeps;
const mockRoleGateConfigs = [];
const mockAclConfigs = [];
const mockCreateKnowledgeHandlers = jest.fn((deps) => {
  mockKnowledgeDeps = deps;
  return mockKnowledgeHandlers;
});
const mockCreateKnowledgeSourceHandlers = jest.fn((deps) => {
  mockSourceDeps = deps;
  return mockSourceHandlers;
});
const mockGenerateCheckAccess = jest.fn((config) => {
  mockRoleGateConfigs.push(config);
  const { permissions } = config;
  return (req, res, next) => {
    if (req.headers['x-deny-role'] === permissions.join(',')) {
      return res.status(403).json({ error: 'role denied', permissions });
    }
    next();
  };
});

jest.mock('@librechat/api', () => ({
  createDefaultKnowledgeConnectorRegistry: jest.fn(() => ({ list: jest.fn(), get: jest.fn() })),
  createKnowledgeHandlers: mockCreateKnowledgeHandlers,
  createKnowledgeSourceHandlers: mockCreateKnowledgeSourceHandlers,
  generateCheckAccess: mockGenerateCheckAccess,
}));

const mockCanAccessResource = jest.fn((config) => {
  mockAclConfigs.push(config);
  const { requiredPermission } = config;
  return (req, res, next) => {
    if (req.headers['x-deny-acl'] === String(requiredPermission)) {
      return res.status(403).json({ error: 'ACL denied' });
    }
    next();
  };
});
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
  canAccessResource: mockCanAccessResource,
}));

const mockDb = {
  getFiles: jest.fn(),
  createKnowledgeBase: jest.fn(),
  getKnowledgeBaseById: jest.fn(),
  listKnowledgeBases: jest.fn(),
  updateKnowledgeBase: jest.fn(),
  createKnowledgeDocument: jest.fn(),
  listKnowledgeDocuments: jest.fn(),
  updateKnowledgeDocument: jest.fn(),
  listKnowledgeSources: jest.fn(),
  createKnowledgeSource: jest.fn(),
  updateKnowledgeSource: jest.fn(),
  getRoleByName: jest.fn(),
};
jest.mock('~/models', () => mockDb);

const mockCleanup = {
  deleteKnowledgeBase: jest.fn(),
  deleteKnowledgeDocument: jest.fn(),
  deleteKnowledgeSource: jest.fn(),
};
jest.mock('~/server/services/Knowledge/cleanup', () => mockCleanup);
jest.mock('~/server/services/Knowledge/jobs', () => ({ enqueueKnowledgeSourceSync: jest.fn() }));
jest.mock('~/server/services/Knowledge/documents', () => ({ ingestKnowledgeDocument: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn(),
  findPubliclyAccessibleResources: jest.fn(),
  grantPermission: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { PermissionBits, Permissions, ResourceType } = require('librechat-data-provider');
const router = require('./knowledgeBases');

const app = express();
app.use(express.json());
app.use('/api/knowledge-bases', router);
const authorized = (method, path) => request(app)[method](path).set('Authorization', 'Bearer test');

describe('knowledge base HTTP routes', () => {
  test('requires authentication and the KNOWLEDGE_BASES.USE role gate', async () => {
    await request(app).get('/api/knowledge-bases').expect(401);
    await authorized('get', '/api/knowledge-bases').set('x-deny-role', Permissions.USE).expect(403);
    await authorized('post', '/api/knowledge-bases')
      .set('x-deny-role', `${Permissions.USE},${Permissions.CREATE}`)
      .send({})
      .expect(403);
    expect(mockRoleGateConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permissions: [Permissions.USE] }),
        expect.objectContaining({ permissions: [Permissions.USE, Permissions.CREATE] }),
      ]),
    );
  });

  test.each([
    ['get', '/api/knowledge-bases', 200, 'list'],
    ['post', '/api/knowledge-bases', 201, 'create'],
    ['get', '/api/knowledge-bases/connectors', 200, 'connectors'],
    ['get', '/api/knowledge-bases/kb-1', 200, 'get'],
    ['patch', '/api/knowledge-bases/kb-1', 200, 'patch'],
    ['delete', '/api/knowledge-bases/kb-1', 200, 'remove'],
    ['get', '/api/knowledge-bases/kb-1/documents', 200, 'listDocuments'],
    ['post', '/api/knowledge-bases/kb-1/documents', 201, 'createDocument'],
    ['patch', '/api/knowledge-bases/kb-1/documents/doc-1', 200, 'patchDocument'],
    ['delete', '/api/knowledge-bases/kb-1/documents/doc-1', 200, 'removeDocument'],
    ['get', '/api/knowledge-bases/kb-1/sources', 200, 'listSources'],
    ['post', '/api/knowledge-bases/kb-1/sources', 201, 'createSource'],
    ['patch', '/api/knowledge-bases/kb-1/sources/source-1', 200, 'patchSource'],
    ['delete', '/api/knowledge-bases/kb-1/sources/source-1', 200, 'removeSource'],
    ['post', '/api/knowledge-bases/kb-1/sources/source-1/sync', 200, 'syncSource'],
  ])('%s %s reaches the %s handler', async (method, path, status, route) => {
    const response = await authorized(method, path).send({});
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ route });
  });

  test.each([
    ['get', '/api/knowledge-bases/kb-1', PermissionBits.VIEW],
    ['get', '/api/knowledge-bases/kb-1/documents', PermissionBits.VIEW],
    ['get', '/api/knowledge-bases/kb-1/sources', PermissionBits.VIEW],
    ['patch', '/api/knowledge-bases/kb-1', PermissionBits.EDIT],
    ['post', '/api/knowledge-bases/kb-1/documents', PermissionBits.EDIT],
    ['post', '/api/knowledge-bases/kb-1/sources/source-1/sync', PermissionBits.EDIT],
    ['delete', '/api/knowledge-bases/kb-1', PermissionBits.DELETE],
  ])('enforces ACL bit %s %s', async (method, path, permission) => {
    const response = await authorized(method, path)
      .set('x-deny-acl', String(permission))
      .send({});
    expect(response.status).toBe(403);
  });

  test('configures knowledge-base ACL resolution and cleanup-backed deletes', () => {
    expect(mockAclConfigs).toContainEqual(
      expect.objectContaining({
        resourceType: ResourceType.KNOWLEDGE_BASE,
        resourceIdParam: 'id',
        idResolver: mockDb.getKnowledgeBaseById,
      }),
    );
    expect(mockKnowledgeDeps).toEqual(
      expect.objectContaining({
        deleteKnowledgeBase: mockCleanup.deleteKnowledgeBase,
        deleteKnowledgeDocument: mockCleanup.deleteKnowledgeDocument,
      }),
    );
    expect(mockSourceDeps).toEqual(
      expect.objectContaining({ deleteKnowledgeSource: mockCleanup.deleteKnowledgeSource }),
    );
  });
});
