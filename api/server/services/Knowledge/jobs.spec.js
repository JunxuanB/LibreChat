jest.mock('~/models', () => ({}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  runAsSystem: (callback) => callback(),
}));
jest.mock('./sync', () => ({ syncKnowledgeSource: jest.fn() }));

const { createKnowledgeSyncWorker } = require('./jobs');

const queuedSource = (overrides = {}) => ({
  _id: 'source-1',
  knowledgeBaseId: 'kb-1',
  syncStatus: 'queued',
  syncAttempts: 0,
  ...overrides,
});

describe('knowledge sync worker', () => {
  it('recovers persisted queued work and runs it under the system context', async () => {
    const source = queuedSource();
    const database = {
      listPendingKnowledgeSourceSyncs: jest.fn().mockResolvedValueOnce([source]),
      updateKnowledgeSourceSyncState: jest.fn(),
    };
    const syncKnowledgeSource = jest.fn(async () => undefined);
    const runAsSystem = jest.fn((callback) => callback());
    const worker = createKnowledgeSyncWorker({ db: database, syncKnowledgeSource, runAsSystem });

    await worker.runOnce();

    expect(runAsSystem).toHaveBeenCalled();
    expect(syncKnowledgeSource).toHaveBeenCalledWith('kb-1', 'source-1');
  });

  it('persists bounded exponential retries after a failed run', async () => {
    const source = queuedSource({ syncAttempts: 1 });
    const database = {
      listPendingKnowledgeSourceSyncs: jest.fn(async () => [source]),
      updateKnowledgeSourceSyncState: jest.fn(async () => undefined),
    };
    const now = () => new Date('2026-09-30T12:00:00.000Z');
    const worker = createKnowledgeSyncWorker({
      db: database,
      syncKnowledgeSource: jest.fn(async () => {
        throw new Error('provider unavailable');
      }),
      runAsSystem: (callback) => callback(),
      now,
    });

    await worker.runOnce();

    expect(database.updateKnowledgeSourceSyncState).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({
        syncStatus: 'queued',
        syncAttempts: 2,
        syncError: 'provider unavailable',
        nextSyncAt: new Date('2026-09-30T12:00:04.000Z'),
      }),
    );
  });

  it('queues a source durably before waking the worker', async () => {
    const source = queuedSource();
    const database = {
      enqueueKnowledgeSourceSync: jest.fn(async () => source),
      listPendingKnowledgeSourceSyncs: jest.fn(async () => []),
      updateKnowledgeSourceSyncState: jest.fn(),
    };
    const worker = createKnowledgeSyncWorker({
      db: database,
      syncKnowledgeSource: jest.fn(),
      runAsSystem: (callback) => callback(),
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    await expect(worker.enqueue('kb-1', 'source-1')).resolves.toBe(source);
    await worker.runOnce();

    expect(database.enqueueKnowledgeSourceSync).toHaveBeenCalledWith(
      'kb-1',
      'source-1',
      new Date('2026-09-30T12:00:00.000Z'),
    );
  });
});
