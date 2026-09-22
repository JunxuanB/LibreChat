jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Files/VectorDB/crud', () => ({ deleteVectors: jest.fn() }));

const { createKnowledgeCleanupService } = require('./cleanup');

const req = { user: { id: 'editor-1' } };
const uploadDocument = {
  _id: { toString: () => 'upload-doc' },
  file_id: 'original-user-file',
};
const connectorDocument = {
  _id: { toString: () => 'connector-doc' },
  file_id: 'generated-file',
  knowledgeSourceId: 'source-1',
};

function build() {
  const database = {
    getKnowledgeDocumentById: jest.fn(async () => uploadDocument),
    findKnowledgeDocumentsBySourceId: jest.fn(async () => [connectorDocument]),
    findKnowledgeDocumentsForCleanup: jest.fn(async () => [uploadDocument, connectorDocument]),
    listKnowledgeSources: jest.fn(async () => []),
    getKnowledgeSourceForSync: jest.fn(async (_baseId, sourceId) => ({
      _id: sourceId,
      tenantId: 'tenant-1',
    })),
    acquireKnowledgeSourceSyncLease: jest.fn(async () => true),
    renewKnowledgeSourceSyncLease: jest.fn(async () => true),
    releaseKnowledgeSourceSyncLease: jest.fn(async () => true),
    deleteKnowledgeDocument: jest.fn(async () => ({ deleted: true })),
    deleteKnowledgeSource: jest.fn(async () => ({ deleted: true })),
    deleteKnowledgeBase: jest.fn(async () => ({ deleted: true })),
    deleteFile: jest.fn(async () => connectorDocument),
  };
  const deleteVectors = jest.fn(async () => undefined);
  return {
    database,
    deleteVectors,
    service: createKnowledgeCleanupService({
      db: database,
      deleteVectors,
      createToken: () => 'cleanup-token',
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    }),
  };
}

describe('knowledge cleanup service', () => {
  it('removes only the KB vector scope when deleting an uploaded document', async () => {
    const { service, database, deleteVectors } = build();
    await service.deleteKnowledgeDocument('kb-1', 'upload-doc', req);
    expect(deleteVectors).toHaveBeenCalledWith(
      req,
      { file_id: 'original-user-file', embedded: true },
      'kb-1',
    );
    expect(database.deleteFile).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeDocument).toHaveBeenCalledWith('kb-1', 'upload-doc');
  });

  it('fences source cleanup with the synchronization lease', async () => {
    const { service, database } = build();
    await service.deleteKnowledgeSource('kb-1', 'source-1', req);
    expect(database.acquireKnowledgeSourceSyncLease).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        sourceId: 'source-1',
        tenantId: 'tenant-1',
        token: 'cleanup-token',
      }),
    );
    expect(database.deleteFile).toHaveBeenCalledWith('generated-file');
    expect(database.deleteKnowledgeDocument).toHaveBeenCalledWith('kb-1', 'connector-doc');
    expect(database.deleteKnowledgeSource).toHaveBeenCalledWith('kb-1', 'source-1');
    expect(database.releaseKnowledgeSourceSyncLease).toHaveBeenCalledWith({
      knowledgeBaseId: 'kb-1',
      sourceId: 'source-1',
      tenantId: 'tenant-1',
      token: 'cleanup-token',
    });
  });

  it('refuses source deletion while synchronization owns the lease', async () => {
    const { service, database, deleteVectors } = build();
    database.acquireKnowledgeSourceSyncLease.mockResolvedValue(false);
    await expect(service.deleteKnowledgeSource('kb-1', 'source-1', req)).rejects.toMatchObject({
      code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS',
    });
    expect(deleteVectors).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeDocument).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeSource).not.toHaveBeenCalled();
  });

  it('returns not found for a missing source without acquiring a lease', async () => {
    const { service, database } = build();
    database.getKnowledgeSourceForSync.mockResolvedValue(null);
    database.deleteKnowledgeSource.mockResolvedValue({ deleted: false });
    await expect(service.deleteKnowledgeSource('kb-1', 'missing', req)).resolves.toEqual({
      deleted: false,
    });
    expect(database.acquireKnowledgeSourceSyncLease).not.toHaveBeenCalled();
  });

  it('preserves original uploads but removes generated files when deleting a KB', async () => {
    const { service, database, deleteVectors } = build();
    await service.deleteKnowledgeBase('kb-1', req);
    expect(deleteVectors).toHaveBeenCalledTimes(2);
    expect(database.deleteFile).toHaveBeenCalledTimes(1);
    expect(database.deleteFile).toHaveBeenCalledWith('generated-file');
    expect(database.deleteKnowledgeBase).toHaveBeenCalledWith('kb-1');
  });
});
