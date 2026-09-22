const { logger, runAsSystem } = require('@librechat/data-schemas');
const db = require('~/models');
const { syncKnowledgeSource } = require('./sync');

const DEFAULT_POLL_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;

function createKnowledgeSyncWorker(overrides = {}) {
  const database = overrides.db ?? db;
  const runSync = overrides.syncKnowledgeSource ?? syncKnowledgeSource;
  const runSystem = overrides.runAsSystem ?? runAsSystem;
  const pollMs = overrides.pollMs ?? DEFAULT_POLL_MS;
  const maxAttempts = overrides.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = overrides.now ?? (() => new Date());
  let interval;
  let draining;

  const runOnce = () => {
    if (draining) return draining;
    draining = (async () => {
      const sources = await runSystem(() => database.listPendingKnowledgeSourceSyncs(now(), 25));
      await Promise.allSettled(
        sources.map(async (source) => {
          const knowledgeBaseId = String(source.knowledgeBaseId);
          const sourceId = String(source._id);
          try {
            await runSystem(() => runSync(knowledgeBaseId, sourceId));
          } catch (error) {
            const attempts = (source.syncAttempts ?? 0) + 1;
            if (attempts >= maxAttempts) return;
            const retryAt = new Date(now().getTime() + Math.min(60_000, 1000 * 2 ** attempts));
            await runSystem(() =>
              database.updateKnowledgeSourceSyncState(sourceId, {
                syncStatus: 'queued',
                nextSyncAt: retryAt,
                syncAttempts: attempts,
                syncError: error instanceof Error ? error.message.slice(0, 4000) : 'Sync failed',
              }),
            );
          }
        }),
      );
    })()
      .catch((error) => logger.error('[knowledge-sync-worker] Queue drain failed', error))
      .finally(() => {
        draining = undefined;
      });
    return draining;
  };

  return {
    runOnce,
    start() {
      if (interval) return;
      interval = setInterval(() => void runOnce(), pollMs);
      interval.unref?.();
      void runOnce();
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = undefined;
    },
    async enqueue(knowledgeBaseId, sourceId) {
      const source = await database.enqueueKnowledgeSourceSync(knowledgeBaseId, sourceId, now());
      if (source) void runOnce();
      return source;
    },
  };
}

const knowledgeSyncWorker = createKnowledgeSyncWorker();

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_MAX_ATTEMPTS,
  createKnowledgeSyncWorker,
  initializeKnowledgeSyncWorker: () => knowledgeSyncWorker.start(),
  stopKnowledgeSyncWorker: () => knowledgeSyncWorker.stop(),
  enqueueKnowledgeSourceSync: (...args) => knowledgeSyncWorker.enqueue(...args),
};
