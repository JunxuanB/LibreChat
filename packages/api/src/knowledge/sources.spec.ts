import { createKnowledgeSourceHandlers } from './sources';
import { KnowledgeSourceSyncInProgressError } from './sync';
import { createDefaultKnowledgeConnectorRegistry } from './connectors';

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

describe('knowledge source handlers', () => {
  const createDeps = () => ({
    connectorRegistry: createDefaultKnowledgeConnectorRegistry(),
    listKnowledgeSources: jest.fn(),
    createKnowledgeSource: jest.fn(),
    updateKnowledgeSource: jest.fn(),
    deleteKnowledgeSource: jest.fn(),
    syncKnowledgeSource: jest.fn(),
  });

  test('returns all registered connector manifests', async () => {
    const deps = createDeps();
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();
    await handlers.connectors({} as never, res as never);
    const body = res.json.mock.calls[0][0];
    expect(body.connectors.map(({ type }: { type: string }) => type)).toEqual([
      'website',
      'github',
      'google_drive',
      'sharepoint',
      'notion',
      'confluence',
      'postgresql',
      'custom_api',
      'mcp',
      'external_index',
    ]);
  });

  test('rejects missing required credentials before persistence', async () => {
    const deps = createDeps();
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();
    await handlers.create(
      {
        params: { id: 'kb-1' },
        body: { name: 'Drive', type: 'google_drive', config: { folderId: 'folder-1' } },
        user: { _id: 'user-1' },
      } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['credentials', 'accessToken'] }),
        ]),
      }),
    );
    expect(deps.createKnowledgeSource).not.toHaveBeenCalled();
  });

  test('rejects secrets in public config and fields outside the manifest', async () => {
    const deps = createDeps();
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();
    await handlers.create(
      {
        params: { id: 'kb-1' },
        body: {
          name: 'Drive',
          type: 'google_drive',
          config: { folderId: 'folder-1', accessToken: 'public-secret', extra: true },
          credentials: { accessToken: 'private-secret' },
        },
        user: { _id: 'user-1' },
      } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['config', 'accessToken'] }),
          expect.objectContaining({ path: ['config', 'extra'] }),
        ]),
      }),
    );
    expect(deps.createKnowledgeSource).not.toHaveBeenCalled();
  });

  test('persists valid credentials without returning them', async () => {
    const deps = createDeps();
    deps.createKnowledgeSource.mockResolvedValue({
      _id: { toString: () => 'source-1' },
      knowledgeBaseId: { toString: () => 'kb-1' },
      name: 'Drive',
      type: 'google_drive',
      config: { folderId: 'folder-1' },
      syncStatus: 'idle',
      connection: { encryptedSecrets: 'ciphertext' },
      createdAt: new Date('2026-09-22T00:00:00.000Z'),
      updatedAt: new Date('2026-09-22T00:00:00.000Z'),
    });
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();
    await handlers.create(
      {
        params: { id: 'kb-1' },
        body: {
          name: 'Drive',
          type: 'google_drive',
          config: { folderId: 'folder-1' },
          credentials: { accessToken: 'private-secret' },
        },
        user: { _id: 'user-1' },
      } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(deps.createKnowledgeSource).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ credentials: { accessToken: 'private-secret' } }),
      }),
    );
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('private-secret');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('encryptedSecrets');
  });

  test('validates patched connector fields and rejects internal sync state', async () => {
    const deps = createDeps();
    deps.listKnowledgeSources.mockResolvedValue([
      {
        _id: { toString: () => 'source-1' },
        knowledgeBaseId: { toString: () => 'base-1' },
        name: 'Drive',
        type: 'google_drive',
        config: { folderId: 'folder-1' },
        connection: { hasSecrets: true },
      },
    ]);
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();

    await handlers.patch(
      {
        params: { id: 'base-1', sourceId: 'source-1' },
        body: { syncStatus: 'ready', config: { unknown: 'value' } },
      } as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(deps.updateKnowledgeSource).not.toHaveBeenCalled();
  });

  test('allows config patches to retain stored credentials', async () => {
    const deps = createDeps();
    const source = {
      _id: { toString: () => 'source-1' },
      knowledgeBaseId: { toString: () => 'base-1' },
      name: 'Drive',
      type: 'google_drive' as const,
      config: { folderId: 'folder-1' },
      connection: { hasSecrets: true },
      syncStatus: 'idle' as const,
    };
    deps.listKnowledgeSources.mockResolvedValue([source]);
    deps.updateKnowledgeSource.mockResolvedValue(source);
    const handlers = createKnowledgeSourceHandlers(deps);
    const res = response();

    await handlers.patch(
      {
        params: { id: 'base-1', sourceId: 'source-1' },
        body: { config: { folderId: 'folder-2' } },
      } as never,
      res as never,
    );

    expect(deps.updateKnowledgeSource).toHaveBeenCalledWith('base-1', 'source-1', {
      config: { folderId: 'folder-2' },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('returns not found when patching a missing source', async () => {
    const deps = createDeps();
    deps.listKnowledgeSources.mockResolvedValue([]);
    const res = response();
    await createKnowledgeSourceHandlers(deps).patch(
      {
        params: { id: 'base-1', sourceId: 'missing' },
        body: { name: 'Renamed' },
      } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(deps.updateKnowledgeSource).not.toHaveBeenCalled();
  });

  test.each([true, false])('maps source deletion deleted=%s', async (deleted) => {
    const deps = createDeps();
    deps.deleteKnowledgeSource.mockResolvedValue({ deleted });
    const res = response();
    const req = { params: { id: 'base-1', sourceId: 'source-1' }, user: { id: 'user-1' } };
    await createKnowledgeSourceHandlers(deps).remove(req as never, res as never);
    expect(deps.deleteKnowledgeSource).toHaveBeenCalledWith('base-1', 'source-1', req);
    expect(res.status).toHaveBeenCalledWith(deleted ? 200 : 404);
  });

  test('returns conflict when source deletion races synchronization', async () => {
    const deps = createDeps();
    const error = Object.assign(new Error('syncing'), {
      code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS',
    });
    deps.deleteKnowledgeSource.mockRejectedValue(error);
    const res = response();

    await createKnowledgeSourceHandlers(deps).remove(
      { params: { id: 'base-1', sourceId: 'source-1' } } as never,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Knowledge source synchronization is in progress',
      code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS',
    });
  });

  test('enqueues sync work instead of patching status directly', async () => {
    const synced = {
      _id: { toString: () => 'source-1' },
      knowledgeBaseId: { toString: () => 'base-1' },
      name: 'Docs',
      type: 'github' as const,
      config: {},
      syncStatus: 'ready' as const,
      createdAt: new Date('2026-09-22T12:00:00.000Z'),
      updatedAt: new Date('2026-09-22T12:00:00.000Z'),
    };
    const syncKnowledgeSource = jest.fn(async () => synced);
    const updateKnowledgeSource = jest.fn();
    const handlers = createKnowledgeSourceHandlers({
      listKnowledgeSources: jest.fn(),
      createKnowledgeSource: jest.fn(),
      updateKnowledgeSource,
      deleteKnowledgeSource: jest.fn(),
      syncKnowledgeSource,
    });
    const res = response();

    await handlers.sync({ params: { id: 'base-1', sourceId: 'source-1' } } as never, res as never);

    expect(syncKnowledgeSource).toHaveBeenCalledWith('base-1', 'source-1');
    expect(updateKnowledgeSource).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('returns a conflict without exposing internal lease state', async () => {
    const handlers = createKnowledgeSourceHandlers({
      listKnowledgeSources: jest.fn(async () => [
        {
          _id: { toString: () => 'source-1' },
          knowledgeBaseId: { toString: () => 'base-1' },
          name: 'Docs',
          type: 'github',
          config: {},
          syncStatus: 'syncing',
          syncLease: { token: 'secret-token', expiresAt: new Date() },
        } as never,
      ]),
      createKnowledgeSource: jest.fn(),
      updateKnowledgeSource: jest.fn(),
      deleteKnowledgeSource: jest.fn(),
      syncKnowledgeSource: jest.fn(async () => {
        throw new KnowledgeSourceSyncInProgressError();
      }),
    });
    const listResponse = response();
    await handlers.list({ params: { id: 'base-1' } } as never, listResponse as never);
    expect(JSON.stringify(listResponse.json.mock.calls[0][0])).not.toContain('secret-token');

    const syncResponse = response();
    await handlers.sync(
      { params: { id: 'base-1', sourceId: 'source-1' } } as never,
      syncResponse as never,
    );
    expect(syncResponse.status).toHaveBeenCalledWith(409);
    expect(syncResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS' }),
    );
  });
});
