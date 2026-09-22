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
    upsertKnowledgeDocumentBySource: jest.fn(async (input) => input),
    deleteKnowledgeDocumentBySource: jest.fn(async () => current),
    createFile: jest.fn(async (input) => input),
    deleteFile: jest.fn(async () => current),
  };
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
      undefined,
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
      undefined,
    );
    expect(database.updateKnowledgeSourceSyncState).toHaveBeenLastCalledWith(
      'source-1',
      expect.objectContaining({ syncStatus: 'ready' }),
    );
  });
});
