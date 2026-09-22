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

const document = {
  _id: { toString: () => 'document-1' },
  knowledgeBaseId: { toString: () => 'base-1' },
  file_id: 'file-1',
  name: 'Runbook.pdf',
  mime_type: 'application/pdf',
  bytes: 42,
  source_type: 'upload' as const,
  status: 'ready' as const,
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
  createKnowledgeDocument: jest.fn().mockResolvedValue(document),
  listKnowledgeDocuments: jest.fn().mockResolvedValue({ documents: [document], nextCursor: null }),
  updateKnowledgeDocument: jest.fn().mockResolvedValue(document),
  deleteKnowledgeDocument: jest.fn().mockResolvedValue({ deleted: true }),
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

  test('merges direct and public access, deduplicates IDs, and bounds pagination', async () => {
    const deps = makeDeps();
    deps.findAccessibleResources.mockResolvedValue(['base-1', 'base-2']);
    deps.findPubliclyAccessibleResources.mockResolvedValue(['base-2', 'base-3']);
    const handlers = createKnowledgeHandlers(deps);
    const res = makeResponse();

    await handlers.list(
      {
        user: { id: 'user-2', role: 'USER' },
        query: { search: 'docs', cursor: 'cursor-1', limit: '1000' },
      } as never,
      res as never,
    );

    expect(deps.listKnowledgeBases).toHaveBeenCalledWith({
      accessibleIds: ['base-1', 'base-2', 'base-3'],
      search: 'docs',
      cursor: 'cursor-1',
      limit: 100,
    });
  });

  test.each([
    ['missing user', { query: {} }, 401],
    ['dependency failure', { user: { id: 'user-1' }, query: {} }, 500],
  ])('handles list %s', async (_label, request, expectedStatus) => {
    const deps = makeDeps();
    if (expectedStatus === 500) deps.findAccessibleResources.mockRejectedValue(new Error('db'));
    const res = makeResponse();
    await createKnowledgeHandlers(deps).list(request as never, res as never);
    expect(res.status).toHaveBeenCalledWith(expectedStatus);
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

  test('validates create and update bodies before persistence', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const createRes = makeResponse();
    const patchRes = makeResponse();
    await handlers.create(
      { user: { id: 'user-1' }, body: { name: '   ' } } as never,
      createRes as never,
    );
    await handlers.patch({ params: { id: 'base-1' }, body: {} } as never, patchRes as never);
    expect(createRes.status).toHaveBeenCalledWith(400);
    expect(patchRes.status).toHaveBeenCalledWith(400);
    expect(deps.createKnowledgeBase).not.toHaveBeenCalled();
    expect(deps.updateKnowledgeBase).not.toHaveBeenCalled();
  });

  test('gets, updates, and deletes a knowledge base', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const getRes = makeResponse();
    const patchRes = makeResponse();
    const deleteRes = makeResponse();

    await handlers.get({ params: { id: 'base-1' } } as never, getRes as never);
    await handlers.patch(
      { params: { id: 'base-1' }, body: { description: 'Updated' } } as never,
      patchRes as never,
    );
    const deleteRequest = { params: { id: 'base-1' }, user: { id: 'user-1' } };
    await handlers.remove(deleteRequest as never, deleteRes as never);

    expect(getRes.status).toHaveBeenCalledWith(200);
    expect(deps.updateKnowledgeBase).toHaveBeenCalledWith('base-1', { description: 'Updated' });
    expect(deps.deleteKnowledgeBase).toHaveBeenCalledWith('base-1', deleteRequest);
    expect(deleteRes.status).toHaveBeenCalledWith(200);
  });

  test.each(['get', 'patch', 'remove'] as const)(
    'returns 404 when %s misses',
    async (operation) => {
      const deps = makeDeps();
      deps.getKnowledgeBaseById.mockResolvedValue(null);
      deps.updateKnowledgeBase.mockResolvedValue(null);
      deps.deleteKnowledgeBase.mockResolvedValue({ deleted: false });
      const res = makeResponse();
      const handlers = createKnowledgeHandlers(deps);
      if (operation === 'get')
        await handlers.get({ params: { id: 'missing' } } as never, res as never);
      if (operation === 'patch')
        await handlers.patch(
          { params: { id: 'missing' }, body: { name: 'Valid' } } as never,
          res as never,
        );
      if (operation === 'remove')
        await handlers.remove({ params: { id: 'missing' } } as never, res as never);
      expect(res.status).toHaveBeenCalledWith(404);
    },
  );

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

  test('lists, creates, updates, and deletes documents with request context', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const listRes = makeResponse();
    const createRes = makeResponse();
    const patchRes = makeResponse();
    const deleteRes = makeResponse();
    const req = {
      params: { id: 'base-1' },
      query: { limit: '10' },
      user: { id: 'user-1', tenantId: 'tenant-1' },
      body: {
        file_id: 'file-1',
        name: 'Runbook.pdf',
        mime_type: 'application/pdf',
        source_type: 'upload',
      },
    };

    await handlers.listDocuments(req as never, listRes as never);
    await handlers.createDocument(req as never, createRes as never);
    await handlers.patchDocument(
      { params: { id: 'base-1', documentId: 'document-1' }, body: { status: 'ready' } } as never,
      patchRes as never,
    );
    const deleteReq = {
      params: { id: 'base-1', documentId: 'document-1' },
      user: { id: 'user-1' },
    };
    await handlers.removeDocument(deleteReq as never, deleteRes as never);

    expect(deps.listKnowledgeDocuments).toHaveBeenCalledWith({
      knowledgeBaseId: 'base-1',
      cursor: null,
      limit: 10,
    });
    expect(deps.canAccessFile).toHaveBeenCalledWith({ fileId: 'file-1', userId: 'user-1' });
    expect(deps.createKnowledgeDocument).toHaveBeenCalledWith(
      'base-1',
      expect.objectContaining({ file_id: 'file-1' }),
      'tenant-1',
      req,
    );
    expect(deps.updateKnowledgeDocument).toHaveBeenCalledWith('base-1', 'document-1', {
      status: 'ready',
    });
    expect(deps.deleteKnowledgeDocument).toHaveBeenCalledWith('base-1', 'document-1', deleteReq);
    for (const res of [listRes, createRes, patchRes, deleteRes]) {
      expect(res.status).toHaveBeenCalledWith(expect.any(Number));
    }
  });

  test.each(['create', 'patch', 'remove'] as const)(
    'returns 404 when document %s misses',
    async (operation) => {
      const deps = makeDeps();
      deps.createKnowledgeDocument.mockResolvedValue(null);
      deps.updateKnowledgeDocument.mockResolvedValue(null);
      deps.deleteKnowledgeDocument.mockResolvedValue({ deleted: false });
      const handlers = createKnowledgeHandlers(deps);
      const res = makeResponse();
      if (operation === 'create')
        await handlers.createDocument(
          {
            params: { id: 'missing' },
            user: { id: 'user-1' },
            body: { name: 'Doc', source_type: 'upload' },
          } as never,
          res as never,
        );
      if (operation === 'patch')
        await handlers.patchDocument(
          { params: { id: 'base-1', documentId: 'missing' }, body: { status: 'failed' } } as never,
          res as never,
        );
      if (operation === 'remove')
        await handlers.removeDocument(
          { params: { id: 'base-1', documentId: 'missing' } } as never,
          res as never,
        );
      expect(res.status).toHaveBeenCalledWith(404);
    },
  );

  test('rejects invalid document create and patch bodies', async () => {
    const deps = makeDeps();
    const handlers = createKnowledgeHandlers(deps);
    const createRes = makeResponse();
    const patchRes = makeResponse();
    await handlers.createDocument(
      { params: { id: 'base-1' }, body: { name: '' } } as never,
      createRes as never,
    );
    await handlers.patchDocument(
      { params: { id: 'base-1', documentId: 'document-1' }, body: { status: 'unknown' } } as never,
      patchRes as never,
    );
    expect(createRes.status).toHaveBeenCalledWith(400);
    expect(patchRes.status).toHaveBeenCalledWith(400);
  });
});
