import { createKnowledgeHandlers } from './handlers';

const makeResponse = () => {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
};

const base = {
  _id: { toString: () => 'base-1' },
  name: 'Engineering',
  description: 'Team docs',
  author: { toString: () => 'user-1' },
  authorName: 'Ada',
  documentCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const makeDeps = () => ({
  canAccessFile: jest.fn().mockResolvedValue(true),
  createKnowledgeBase: jest.fn().mockResolvedValue(base),
  getKnowledgeBaseById: jest.fn().mockResolvedValue(base),
  listKnowledgeBases: jest.fn().mockResolvedValue({ knowledgeBases: [base], nextCursor: null }),
  updateKnowledgeBase: jest.fn().mockResolvedValue(base),
  deleteKnowledgeBase: jest.fn().mockResolvedValue({ deleted: true }),
  createKnowledgeDocument: jest.fn(),
  listKnowledgeDocuments: jest.fn().mockResolvedValue({ documents: [], nextCursor: null }),
  updateKnowledgeDocument: jest.fn(),
  deleteKnowledgeDocument: jest.fn(),
  findAccessibleResources: jest.fn().mockResolvedValue([{ toString: () => 'base-1' }]),
  findPubliclyAccessibleResources: jest.fn().mockResolvedValue([]),
  grantPermission: jest.fn().mockResolvedValue(undefined),
});

describe('knowledge base handlers', () => {
  test('lists only ACL-resolved knowledge bases', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const res = makeResponse();

    await handlers.list({ user: { id: 'user-1', role: 'USER' }, query: {} } as never, res as never);

    expect(deps.findAccessibleResources).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'knowledgeBase', requiredPermissions: 1 }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBases: [expect.objectContaining({ _id: 'base-1' })] }),
    );
  });

  test('grants the creator the owner role', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const res = makeResponse();

    await handlers.create(
      {
        user: { id: 'user-1', _id: 'user-1', name: 'Ada' },
        body: { name: 'Engineering', description: 'Team docs' },
      } as never,
      res as never,
    );

    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'knowledgeBase',
        accessRoleId: 'knowledgeBase_owner',
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('removes a new knowledge base when the owner grant fails', async () => {
    const deps = makeDeps();
    deps.grantPermission.mockRejectedValueOnce(new Error('ACL unavailable'));
    const handlers = createKnowledgeHandlers(deps);
    const res = makeResponse();

    await handlers.create(
      { user: { id: 'user-1', name: 'Ada' }, body: { name: 'Engineering' } } as never,
      res as never,
    );

    expect(deps.deleteKnowledgeBase).toHaveBeenCalledWith('base-1');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('rejects linking a file the caller does not own', async () => {
    const deps = makeDeps();
    deps.canAccessFile.mockResolvedValue(false);
    const handlers = createKnowledgeHandlers(deps);
    const res = makeResponse();

    await handlers.createDocument(
      {
        params: { id: 'base-1' },
        user: { id: 'user-1' },
        body: { file_id: 'file-2', name: 'private.txt', source_type: 'upload' },
      } as never,
      res as never,
    );

    expect(deps.canAccessFile).toHaveBeenCalledWith({ fileId: 'file-2', userId: 'user-1' });
    expect(deps.createKnowledgeDocument).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
