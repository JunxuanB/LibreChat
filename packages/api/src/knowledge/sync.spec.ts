import type { KnowledgeConnector, KnowledgeSourceItem } from './connectors/types';
import {
  KnowledgeSourceSyncRunner,
  type KnowledgeSourceSyncDependencies,
  type KnowledgeSyncSource,
  type KnowledgeSyncState,
} from './sync';

const source: KnowledgeSyncSource = {
  id: 'source-1',
  knowledgeBaseId: 'base-1',
  connectionId: 'connection-1',
  type: 'github',
  config: { repository: 'owner/repo' },
};

function createHarness(connector: Pick<KnowledgeConnector, 'validate' | 'sync'>) {
  let currentSource = { ...source };
  const documents = new Map<string, KnowledgeSourceItem>();
  const states: KnowledgeSyncState[] = [];
  const deps: KnowledgeSourceSyncDependencies = {
    loadSource: jest.fn(async () => ({ ...currentSource })),
    loadCredentials: jest.fn(async () => ({ token: 'secret' })),
    connectorRegistry: { get: jest.fn(() => connector) },
    connectorContext: {
      fetch: jest.fn() as unknown as typeof fetch,
      assertSafeUrl: jest.fn(async () => undefined),
    },
    upsertDocument: jest.fn(async (key, item) => {
      documents.set(`${key.sourceId}:${item.externalId}`, item);
    }),
    deleteDocument: jest.fn(async (key, externalId) => {
      documents.delete(`${key.sourceId}:${externalId}`);
    }),
    reconcileDocuments: jest.fn(async (key, retainedExternalIds) => {
      const retained = new Set(retainedExternalIds);
      let deleted = 0;
      for (const documentKey of [...documents.keys()]) {
        if (
          documentKey.startsWith(`${key.sourceId}:`) &&
          !retained.has(documentKey.split(':')[1])
        ) {
          documents.delete(documentKey);
          deleted += 1;
        }
      }
      return deleted;
    }),
    updateSourceState: jest.fn(async (_sourceId, state) => {
      states.push(state);
      if (state.cursor !== undefined) currentSource = { ...currentSource, cursor: state.cursor };
    }),
    now: () => new Date('2026-09-22T12:00:00.000Z'),
  };
  return { runner: new KnowledgeSourceSyncRunner(deps), deps, documents, states };
}

describe('KnowledgeSourceSyncRunner', () => {
  test('persists its cursor and idempotently upserts the same external item', async () => {
    const seenCursors: Array<string | undefined> = [];
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest.fn(async (request: { cursor?: string }) => {
        seenCursors.push(request.cursor);
        return {
          changes: [
            {
              operation: 'upsert' as const,
              item: { externalId: 'README.md', title: 'README', content: 'hello' },
            },
          ],
          cursor: 'cursor-1',
        };
      }),
    };
    const { runner, documents, states } = createHarness(connector);

    await runner.run('base-1', 'source-1');
    await runner.run('base-1', 'source-1');

    expect(seenCursors).toEqual([undefined, 'cursor-1']);
    expect(documents.size).toBe(1);
    expect(states).toContainEqual({
      syncStatus: 'ready',
      syncError: null,
      cursor: 'cursor-1',
      lastSyncedAt: new Date('2026-09-22T12:00:00.000Z'),
    });
  });

  test('applies deletion changes through persistence', async () => {
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest
        .fn()
        .mockResolvedValueOnce({
          changes: [
            { operation: 'upsert', item: { externalId: 'old', title: 'Old', content: 'old' } },
          ],
        })
        .mockResolvedValueOnce({ changes: [{ operation: 'delete', externalId: 'old' }] }),
    } as Pick<KnowledgeConnector, 'validate' | 'sync'>;
    const { runner, documents } = createHarness(connector);

    await runner.run('base-1', 'source-1');
    await runner.run('base-1', 'source-1');

    expect(documents.size).toBe(0);
  });

  test('consumes every connector page in one sync run', async () => {
    const seen = [] as Array<{ cursor?: string; continuation?: boolean }>;
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest.fn(async (request: { cursor?: string; continuation?: boolean }) => {
        seen.push({ cursor: request.cursor, continuation: request.continuation });
        if (!request.continuation) {
          return {
            changes: [{ operation: 'upsert' as const, item: { externalId: 'one', title: 'One' } }],
            cursor: 'page-2',
            complete: false,
          };
        }
        return {
          changes: [{ operation: 'upsert' as const, item: { externalId: 'two', title: 'Two' } }],
          cursor: 'complete',
          complete: true,
        };
      }),
    };
    const { runner, documents } = createHarness(connector);

    await expect(runner.run('base-1', 'source-1')).resolves.toMatchObject({
      upserted: 2,
      cursor: 'complete',
    });
    expect(seen).toEqual([
      { cursor: undefined, continuation: false },
      { cursor: 'page-2', continuation: true },
    ]);
    expect([...documents.keys()]).toEqual(['source-1:one', 'source-1:two']);
  });

  test('reconciles documents absent from a completed full snapshot', async () => {
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest
        .fn()
        .mockResolvedValueOnce({
          changes: [
            { operation: 'upsert', item: { externalId: 'kept', title: 'Kept' } },
            { operation: 'upsert', item: { externalId: 'removed', title: 'Removed' } },
          ],
          snapshot: true,
        })
        .mockResolvedValueOnce({
          changes: [{ operation: 'upsert', item: { externalId: 'kept', title: 'Kept' } }],
          snapshot: true,
        }),
    } as Pick<KnowledgeConnector, 'validate' | 'sync'>;
    const { runner, documents, deps } = createHarness(connector);

    await runner.run('base-1', 'source-1');
    await expect(runner.run('base-1', 'source-1')).resolves.toMatchObject({ deleted: 1 });

    expect(documents.has('source-1:kept')).toBe(true);
    expect(documents.has('source-1:removed')).toBe(false);
    expect(deps.reconcileDocuments).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: 'source-1' }),
      ['kept'],
      undefined,
    );
  });

  test('marks the source failed and preserves the connector error', async () => {
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest.fn(async () => {
        throw new Error('provider rejected secret');
      }),
    } as Pick<KnowledgeConnector, 'validate' | 'sync'>;
    const { runner, states } = createHarness(connector);

    await expect(runner.run('base-1', 'source-1')).rejects.toThrow('provider rejected [REDACTED]');
    expect(states).toEqual([
      { syncStatus: 'syncing', syncError: null },
      { syncStatus: 'failed', syncError: 'provider rejected [REDACTED]' },
    ]);
  });

  test('coalesces concurrent runs for the same source', async () => {
    let release: ((value: { changes: [] }) => void) | undefined;
    const pending = new Promise<{ changes: [] }>((resolve) => {
      release = resolve;
    });
    const connector = {
      validate: jest.fn(async () => undefined),
      sync: jest.fn(() => pending),
    } as Pick<KnowledgeConnector, 'validate' | 'sync'>;
    const { runner } = createHarness(connector);

    const first = runner.run('base-1', 'source-1');
    const second = runner.run('base-1', 'source-1');
    expect(second).toBe(first);
    release?.({ changes: [] });
    await Promise.all([first, second]);

    expect(connector.sync).toHaveBeenCalledTimes(1);
  });
});
