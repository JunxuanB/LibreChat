import Redis from 'ioredis';
import { readScheduleMCPReceipts } from 'librechat-data-provider';
import type { IJobStoreV2 } from '~/stream/interfaces/IJobStore';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';

const denial = {
  server: 'Files',
  status: 'mcp_reauth_required' as const,
  reason: 'consent_revoked' as const,
  recovery: 'authorize' as const,
  automaticReplay: false as const,
  detail: 'unattended_auth_required' as const,
};
const encoded = `mcp_reauth_required: ${JSON.stringify([denial])}`;

async function verify(store: IJobStoreV2): Promise<string> {
  const stream = `receipt-${Date.now()}`;
  const created = await store.createJob(stream, 'owner', 'conversation', 'tenant');
  await store.updateJob(
    stream,
    { scheduleOutcome: 'error', scheduleOutcomeError: encoded },
    created.createdAt,
  );
  await store.updateJob(
    stream,
    { scheduleOutcome: 'success', scheduleOutcomeError: 'completed' },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual([
    denial,
  ]);
  await store.transitionStatus(stream, {
    from: 'running',
    to: 'requires_action',
    expectCreatedAt: created.createdAt,
    patch: { scheduleOutcome: 'interrupted', scheduleOutcomeError: 'Schedule deleted' },
  });
  expect((await store.getJob(stream))?.scheduleOutcome).toBe('error');
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual([
    denial,
  ]);
  const other = {
    ...denial,
    server: 'Warehouse',
    status: 'mcp_permission_denied' as const,
    reason: 'tool_policy_denied' as const,
    recovery: 'restore_permission' as const,
  };
  await store.updateJob(
    stream,
    { scheduleOutcomeError: `mcp_permission_denied: ${JSON.stringify([other])}` },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining([denial, other]),
  );
  await store.transitionStatus(stream, {
    from: 'requires_action',
    to: 'error',
    expectCreatedAt: created.createdAt,
    clear: ['scheduleOutcome', 'scheduleOutcomeError'],
  });
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining([denial, other]),
  );
  await store.deleteJob(stream, created.createdAt);
  return stream;
}

it('retains all denial evidence under memory metadata/status writes and clears', async () => {
  const store = new InMemoryJobStore();
  const stream = await verify(store);
  await expect(store.getJob(stream)).resolves.toBeNull();
});
const redisDescribe = process.env.B2_REDIS_SOCKET ? describe : describe.skip;
redisDescribe('real Redis receipt retention', () => {
  it('retains all denial evidence atomically in real Redis without affecting a replaced epoch', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    try {
      await redis.connect();
      const store = new RedisJobStore(redis);
      await verify(store);
      const old = await store.createJob('epoch-receipt', 'owner');
      await store.deleteJob('epoch-receipt', old.createdAt);
      const current = await store.createJob('epoch-receipt', 'owner');
      await store.updateJob('epoch-receipt', { scheduleOutcomeError: encoded }, old.createdAt);
      expect((await store.getJob('epoch-receipt'))?.scheduleOutcomeError).toBeUndefined();
      await store.deleteJob('epoch-receipt', current.createdAt);
    } finally {
      await redis.quit();
    }
  });
});
