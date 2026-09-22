const fs = require('fs');

jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  deleteVectors: jest.fn(),
  uploadVectors: jest.fn(),
}));

const { createDefaultKnowledgeConnectorRegistry } = require('@librechat/api');
const { createKnowledgeSourceSyncService } = require('./sync');

const source = (overrides = {}) => ({
  _id: 'source-1',
  knowledgeBaseId: 'kb-1',
  connectionId: 'connection-1',
  owner: 'user-1',
  tenantId: 'tenant-1',
  name: 'Source',
  type: 'website',
  config: {},
  syncStatus: 'idle',
  ...overrides,
});

const build = ({
  changes,
  current = null,
  sourceOverrides = {},
  registry,
  databaseOverrides,
  serviceOverrides = {},
} = {}) => {
  const record = source(sourceOverrides);
  const connectorRegistry = registry ?? {
    get: jest.fn(() => ({
      validate: jest.fn(async () => undefined),
      sync: jest.fn(async () => ({ changes: changes ?? [], cursor: 'cursor-2' })),
    })),
  };
  const database = {
    getKnowledgeSourceForSync: jest.fn(async () => record),
    getKnowledgeConnectionSecrets: jest.fn(async () => ({ token: 'secret' })),
    updateKnowledgeSourceSyncState: jest.fn(async () => undefined),
    findKnowledgeDocumentBySource: jest.fn(async () => current),
    findKnowledgeDocumentsBySourceId: jest.fn(async () => []),
    upsertKnowledgeDocumentBySource: jest.fn(async (input) => input),
    deleteKnowledgeDocumentBySource: jest.fn(async () => current),
    createFile: jest.fn(async (input) => input),
    deleteFile: jest.fn(async () => current),
    acquireKnowledgeSourceSyncLease: jest.fn(async () => true),
    renewKnowledgeSourceSyncLease: jest.fn(async () => true),
    releaseKnowledgeSourceSyncLease: jest.fn(async () => true),
    ...databaseOverrides,
  };
  database.updateKnowledgeSourceSyncStateIfLeaseOwner ??= jest.fn(async (_id, _token, state) => {
    await database.updateKnowledgeSourceSyncState(_id, state);
    return true;
  });
  const uploadVectors = jest.fn(async () => ({
    bytes: 5,
    filepath: 'vectordb',
    embedded: true,
  }));
  const deleteVectors = jest.fn(async () => undefined);
  const callMcp = jest.fn(async () => ({ resources: [] }));
  const service = createKnowledgeSourceSyncService({
    db: database,
    connectorRegistry,
    uploadVectors,
    deleteVectors,
    fetch: jest.fn(),
    assertSafeUrl: jest.fn(async () => undefined),
    callMcp,
    ...serviceOverrides,
  });
  return { service, database, uploadVectors, deleteVectors, callMcp };
};

describe('knowledge source ingestion service', () => {
  it('embeds connector content in the knowledge-base namespace and removes its temp file', async () => {
    let tempPath;
    const { service, database, uploadVectors } = build({
      changes: [
        {
          operation: 'upsert',
          item: {
            externalId: 'page-1',
            title: 'Page one',
            content: 'hello',
            mimeType: 'text/plain',
            revision: 'rev-1',
          },
        },
      ],
    });
    uploadVectors.mockImplementation(async ({ file, entity_id }) => {
      tempPath = file.path;
      expect(entity_id).toBe('kb-1');
      expect(fs.existsSync(tempPath)).toBe(true);
      expect(fs.readFileSync(tempPath, 'utf8')).toBe('hello');
      return { bytes: 5, filepath: 'vectordb', embedded: true };
    });

    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(fs.existsSync(tempPath)).toBe(false);
    expect(database.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user-1', embedded: true, source: 'vectordb' }),
      true,
    );
    expect(database.upsertKnowledgeDocumentBySource).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        sourceId: 'source-1',
        externalId: 'page-1',
        sourceType: 'website',
        revision: 'rev-1',
      }),
    );
  });

  it('skips an unchanged revision without uploading another vector', async () => {
    const { service, uploadVectors, database } = build({
      current: { file_id: 'existing-file', revision: 'rev-1' },
      changes: [
        {
          operation: 'upsert',
          item: { externalId: 'page-1', title: 'Page', content: 'same', revision: 'rev-1' },
        },
      ],
    });

    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(uploadVectors).not.toHaveBeenCalled();
    expect(database.upsertKnowledgeDocumentBySource).not.toHaveBeenCalled();
  });

  it('removes replaced vectors and file records after committing the new revision', async () => {
    const { service, deleteVectors, database } = build({
      current: { file_id: 'old-file', revision: 'rev-1' },
      changes: [
        {
          operation: 'upsert',
          item: { externalId: 'page-1', title: 'Page', content: 'new', revision: 'rev-2' },
        },
      ],
    });

    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(deleteVectors).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
      { file_id: 'old-file', embedded: true },
      'kb-1',
    );
    expect(database.deleteFile).toHaveBeenCalledWith('old-file');
  });

  it('runs an incremental connector through create, replace, and delete lifecycle', async () => {
    const documents = new Map();
    let feed = 0;
    const fetch = jest.fn(async (_url, init = {}) => {
      if (init.method === 'HEAD') return new Response('', { status: 200 });
      feed += 1;
      return new Response(
        JSON.stringify(
          feed === 1
            ? {
                items: [
                  { id: 'kept', title: 'Kept', content: 'version one', revision: 'v1' },
                  { id: 'removed', title: 'Removed', content: 'old', revision: 'v1' },
                ],
                cursor: 'cursor-1',
              }
            : {
                items: [{ id: 'kept', title: 'Kept', content: 'version two', revision: 'v2' }],
                deleted: ['removed'],
                cursor: 'cursor-2',
              },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const { service, database, uploadVectors, deleteVectors } = build({
      registry: createDefaultKnowledgeConnectorRegistry(),
      sourceOverrides: {
        type: 'custom_api',
        config: { url: 'https://feed.example.test/documents' },
        cursor: undefined,
      },
      serviceOverrides: { fetch },
    });
    database.findKnowledgeDocumentBySource.mockImplementation(async ({ externalId }) =>
      documents.get(externalId),
    );
    database.upsertKnowledgeDocumentBySource.mockImplementation(async (document) => {
      documents.set(document.externalId, document);
      return document;
    });
    database.deleteKnowledgeDocumentBySource.mockImplementation(async ({ externalId }) => {
      const document = documents.get(externalId);
      documents.delete(externalId);
      return document;
    });
    database.updateKnowledgeSourceSyncStateIfLeaseOwner.mockImplementation(
      async (_id, _token, state) => {
        if (state.cursor !== undefined) {
          sourceRecord.cursor = state.cursor;
        }
        return true;
      },
    );
    const sourceRecord = await database.getKnowledgeSourceForSync('kb-1', 'source-1');

    await service.syncKnowledgeSource('kb-1', 'source-1');
    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(uploadVectors).toHaveBeenCalledTimes(3);
    expect(documents.size).toBe(1);
    expect(documents.get('kept')).toMatchObject({ revision: 'v2', externalId: 'kept' });
    expect(deleteVectors).toHaveBeenCalledTimes(2);
    expect(deleteVectors.mock.calls.every((call) => call[2] === 'kb-1')).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method !== 'HEAD')[1][0].toString()).toBe(
      'https://feed.example.test/documents?cursor=cursor-1',
    );
  });

  it('removes persisted documents omitted from a completed connector snapshot', async () => {
    const registry = {
      get: jest.fn(() => ({
        validate: jest.fn(async () => undefined),
        sync: jest.fn(async () => ({
          changes: [
            {
              operation: 'upsert',
              item: { externalId: 'kept', title: 'Kept', content: 'current' },
            },
          ],
          snapshot: true,
        })),
      })),
    };
    const stale = { source_id: 'removed', file_id: 'stale-file' };
    const { service, database, deleteVectors } = build({
      registry,
      databaseOverrides: {
        findKnowledgeDocumentsBySourceId: jest.fn(async () => [
          { source_id: 'kept', file_id: 'kept-file' },
          stale,
        ]),
        findKnowledgeDocumentBySource: jest.fn(async ({ externalId }) =>
          externalId === 'removed' ? stale : null,
        ),
      },
    });

    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(deleteVectors).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ file_id: 'stale-file' }),
      'kb-1',
    );
    expect(database.deleteFile).toHaveBeenCalledWith('stale-file');
    expect(database.deleteKnowledgeDocumentBySource).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'removed' }),
    );
  });

  it('loads the administrator PostgreSQL policy and supplies the hardened executor', async () => {
    const executeReadOnlyQuery = jest.fn(async (_connection, query) =>
      query === 'SELECT 1 AS connected' ? [{ connected: 1 }] : [],
    );
    const createReadOnlyPostgresExecutor = jest.fn(() => executeReadOnlyQuery);
    const getAppConfig = jest.fn(async () => ({
      knowledgeBaseConnectors: { postgresql: { maxRows: 25 } },
    }));
    const { service, database } = build({
      registry: createDefaultKnowledgeConnectorRegistry(),
      sourceOverrides: {
        type: 'postgresql',
        config: {
          relation: 'articles',
          idColumn: 'id',
          titleColumn: 'title',
          contentColumns: ['body'],
        },
      },
      serviceOverrides: { createReadOnlyPostgresExecutor, getAppConfig },
    });
    database.getKnowledgeConnectionSecrets.mockResolvedValue({
      connectionString: 'postgres://readonly:secret@example.com/db',
    });

    await expect(service.syncKnowledgeSource('kb-1', 'source-1')).resolves.toEqual(
      expect.objectContaining({ _id: 'source-1' }),
    );
    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(createReadOnlyPostgresExecutor).toHaveBeenCalledWith({ maxRows: 25 });
    expect(executeReadOnlyQuery).toHaveBeenCalledWith(
      'postgres://readonly:secret@example.com/db',
      'SELECT 1 AS connected',
      [],
      expect.any(AbortSignal),
    );
  });

  it('binds MCP resource access to the persisted source owner and tenant', async () => {
    const { service, database, callMcp } = build({
      registry: createDefaultKnowledgeConnectorRegistry(),
      sourceOverrides: {
        type: 'mcp',
        connectionId: undefined,
        config: { serverName: 'docs' },
      },
    });

    await service.syncKnowledgeSource('kb-1', 'source-1');

    expect(callMcp).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', tenantId: 'tenant-1' }),
      'docs',
      'resources/list',
      {},
      expect.any(AbortSignal),
    );
    expect(database.updateKnowledgeSourceSyncState).toHaveBeenLastCalledWith(
      'source-1',
      expect.objectContaining({ syncStatus: 'ready' }),
    );
  });

  it('coalesces local calls while rejecting a competing service instance', async () => {
    let lease;
    let finish;
    const gate = new Promise((resolve) => {
      finish = resolve;
    });
    const connectorRegistry = {
      get: () => ({
        validate: jest.fn(async () => undefined),
        sync: jest.fn(async () => {
          await gate;
          return { changes: [] };
        }),
      }),
    };
    const shared = {
      acquireKnowledgeSourceSyncLease: jest.fn(async (next) => {
        if (lease && lease.expiresAt > next.now) return false;
        lease = next;
        return true;
      }),
      releaseKnowledgeSourceSyncLease: jest.fn(async ({ token }) => {
        if (lease?.token !== token) return false;
        lease = undefined;
        return true;
      }),
    };
    const first = build({ registry: connectorRegistry, databaseOverrides: shared }).service;
    const second = build({ registry: connectorRegistry, databaseOverrides: shared }).service;

    const running = first.syncKnowledgeSource('kb-1', 'source-1');
    const coalesced = first.syncKnowledgeSource('kb-1', 'source-1');
    expect(coalesced).toBe(running);
    await expect(second.syncKnowledgeSource('kb-1', 'source-1')).rejects.toMatchObject({
      code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS',
    });
    finish();
    await running;
  });

  it('releases its token when connector sync fails', async () => {
    const { service, database } = build({
      registry: {
        get: () => ({
          validate: jest.fn(async () => undefined),
          sync: jest.fn(async () => {
            throw new Error('connector failed');
          }),
        }),
      },
    });

    await expect(service.syncKnowledgeSource('kb-1', 'source-1')).rejects.toThrow(
      'connector failed',
    );
    expect(database.releaseKnowledgeSourceSyncLease).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        sourceId: 'source-1',
        tenantId: 'tenant-1',
        token: expect.any(String),
      }),
    );
  });

  it('renews the lease while a long connector sync is running', async () => {
    jest.useFakeTimers();
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { service, database } = build({
      registry: {
        get: () => ({
          validate: jest.fn(async () => undefined),
          sync: jest.fn(async () => {
            await pending;
            return { changes: [] };
          }),
        }),
      },
      serviceOverrides: { leaseHeartbeatMs: 10, leaseDurationMs: 100 },
    });
    const running = service.syncKnowledgeSource('kb-1', 'source-1');
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    expect(database.renewKnowledgeSourceSyncLease).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.any(String), expiresAt: expect.any(Date) }),
    );
    finish();
    await running;
    jest.useRealTimers();
  });

  it('aborts work and cannot commit stale status after lease loss', async () => {
    jest.useFakeTimers();
    let ownsLease = true;
    const states = [];
    const { service, database } = build({
      registry: {
        get: () => ({
          validate: jest.fn(async () => undefined),
          sync: jest.fn(
            (request) =>
              new Promise((_resolve, reject) => {
                request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                  once: true,
                });
              }),
          ),
        }),
      },
      databaseOverrides: {
        renewKnowledgeSourceSyncLease: jest.fn(async () => {
          ownsLease = false;
          return false;
        }),
        updateKnowledgeSourceSyncStateIfLeaseOwner: jest.fn(async (_id, _token, state) => {
          if (!ownsLease) return false;
          states.push(state);
          return true;
        }),
      },
      serviceOverrides: { leaseHeartbeatMs: 10, leaseDurationMs: 100 },
    });
    const running = service.syncKnowledgeSource('kb-1', 'source-1');
    const rejected = running.then(
      () => undefined,
      (error) => error,
    );
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    await expect(rejected).resolves.toMatchObject({
      code: 'KNOWLEDGE_SOURCE_SYNC_LEASE_LOST',
    });
    expect(states).toEqual([
      {
        syncStatus: 'syncing',
        syncError: null,
        syncAttempts: 1,
        nextSyncAt: null,
      },
    ]);
    expect(database.releaseKnowledgeSourceSyncLease).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
