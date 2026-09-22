import { createKnowledgeSourceHandlers } from './sources';
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

  test('invokes the injected sync runner instead of patching status directly', async () => {
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
});
