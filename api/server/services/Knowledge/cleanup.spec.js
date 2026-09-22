jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Files/VectorDB/crud', () => ({ deleteVectors: jest.fn() }));

const { createKnowledgeCleanupService } = require('./cleanup');

const build = ({ documents = [] } = {}) => {
  const database = {
    getKnowledgeDocumentById: jest.fn(async (_baseId, documentId) =>
      documents.find((document) => document._id.toString() === documentId),
    ),
    findKnowledgeDocumentsBySourceId: jest.fn(async () => documents),
    findKnowledgeDocumentsForCleanup: jest.fn(async () => documents),
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
    deleteFile: jest.fn(async () => ({ deleted: true })),
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
};

const document = (id, overrides = {}) => ({
  _id: { toString: () => id },
  file_id: `file-${id}`,
  ...overrides,
});
const req = { user: { id: 'user-1' } };

describe('knowledge cleanup service', () => {
  test('deletes one document only after vector and connector-file cleanup', async () => {
    const doc = document('doc-1', { knowledgeSourceId: 'source-1' });
    const { service, database, deleteVectors } = build({ documents: [doc] });

    await expect(service.deleteKnowledgeDocument('base-1', 'doc-1', req)).resolves.toEqual({
      deleted: true,
    });
    expect(deleteVectors).toHaveBeenCalledWith(
      req,
      { file_id: 'file-doc-1', embedded: true },
      'base-1',
    );
    expect(database.deleteFile).toHaveBeenCalledWith('file-doc-1');
    expect(database.deleteKnowledgeDocument).toHaveBeenCalledWith('base-1', 'doc-1');
    expect(deleteVectors.mock.invocationCallOrder[0]).toBeLessThan(
      database.deleteKnowledgeDocument.mock.invocationCallOrder[0],
    );
  });

  test('returns not found without cleanup for a missing document', async () => {
    const { service, database, deleteVectors } = build();
    await expect(service.deleteKnowledgeDocument('base-1', 'missing', req)).resolves.toEqual({
      deleted: false,
    });
    expect(deleteVectors).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeDocument).not.toHaveBeenCalled();
  });

  test('cleans every source document before removing the source', async () => {
    const docs = [document('doc-1', { knowledgeSourceId: 'source-1' }), document('doc-2')];
    const { service, database, deleteVectors } = build({ documents: docs });
    await service.deleteKnowledgeSource('base-1', 'source-1', req);
    expect(deleteVectors).toHaveBeenCalledTimes(2);
    expect(database.deleteKnowledgeDocument).toHaveBeenCalledTimes(2);
    expect(database.deleteKnowledgeSource).toHaveBeenCalledWith('base-1', 'source-1');
    expect(database.acquireKnowledgeSourceSyncLease).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'base-1',
        sourceId: 'source-1',
        tenantId: 'tenant-1',
        token: 'cleanup-token',
      }),
    );
    expect(database.releaseKnowledgeSourceSyncLease).toHaveBeenCalledWith({
      knowledgeBaseId: 'base-1',
      sourceId: 'source-1',
      tenantId: 'tenant-1',
      token: 'cleanup-token',
    });
  });

  test('refuses source deletion while synchronization owns the lease', async () => {
    const { service, database, deleteVectors } = build({
      documents: [document('doc-1', { knowledgeSourceId: 'source-1' })],
    });
    database.acquireKnowledgeSourceSyncLease.mockResolvedValue(false);

    await expect(service.deleteKnowledgeSource('base-1', 'source-1', req)).rejects.toMatchObject({
      code: 'KNOWLEDGE_SOURCE_SYNC_IN_PROGRESS',
    });
    expect(deleteVectors).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeDocument).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeSource).not.toHaveBeenCalled();
  });

  test('returns not found for a missing source without acquiring a lease', async () => {
    const { service, database } = build();
    database.getKnowledgeSourceForSync.mockResolvedValue(null);
    database.deleteKnowledgeSource.mockResolvedValue({ deleted: false });

    await expect(service.deleteKnowledgeSource('base-1', 'missing', req)).resolves.toEqual({
      deleted: false,
    });
    expect(database.acquireKnowledgeSourceSyncLease).not.toHaveBeenCalled();
  });

  test('cleans all vectors before deleting a knowledge base', async () => {
    const { service, database, deleteVectors } = build({
      documents: [document('doc-1'), document('doc-2', { file_id: undefined })],
    });
    await service.deleteKnowledgeBase('base-1', req);
    expect(deleteVectors).toHaveBeenCalledTimes(1);
    expect(database.deleteFile).not.toHaveBeenCalled();
    expect(database.deleteKnowledgeBase).toHaveBeenCalledWith('base-1');
  });

  test('requires an authenticated owner before destructive vector cleanup', async () => {
    const { service, database } = build({ documents: [document('doc-1')] });
    await expect(service.deleteKnowledgeBase('base-1')).rejects.toThrow(
      'Authentication is required for knowledge cleanup',
    );
    expect(database.deleteKnowledgeBase).not.toHaveBeenCalled();
  });

  test('does not delete metadata when vector cleanup fails', async () => {
    const { service, database, deleteVectors } = build({ documents: [document('doc-1')] });
    deleteVectors.mockRejectedValue(new Error('vector store unavailable'));
    await expect(service.deleteKnowledgeDocument('base-1', 'doc-1', req)).rejects.toThrow(
      'vector store unavailable',
    );
    expect(database.deleteKnowledgeDocument).not.toHaveBeenCalled();
  });
});
