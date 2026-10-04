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
  const policy = {
    server: 'Policy',
    agentId: 'child',
    status: 'mcp_permission_denied' as const,
    reason: 'tool_policy_denied' as const,
    recovery: 'configure' as const,
    automaticReplay: false as const,
  };
  const mixed = [denial, other, policy];
  await store.updateJob(
    stream,
    {
      scheduleMCPFailure: policy,
      scheduleOutcomeError: `mcp_permission_denied: ${JSON.stringify(mixed)}`,
    },
    created.createdAt,
  );
  await store.updateJob(
    stream,
    { scheduleMCPFailure: denial, scheduleOutcomeError: encoded },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining(mixed),
  );
  expect((await store.getJob(stream))?.scheduleMCPFailure).toEqual(policy);
  await store.updateJob(stream, { preserveForScheduleReconcile: true }, created.createdAt);
  await expect(store.createJob(stream, 'owner', 'conversation', 'tenant')).rejects.toMatchObject({
    name: 'JobPredecessorMismatchError',
  });
  expect((await store.getJob(stream))?.createdAt).toBe(created.createdAt);
  await store.updateJob(stream, { preserveForScheduleReconcile: false }, created.createdAt);
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
  it('retains a Redis-only receipt beyond terminal TTL until epoch-fenced acknowledgement', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { completedTtl: 1 });
    const created = await store.createJob('retained-receipt', 'owner');
    try {
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: true, scheduleOutcomeError: encoded },
        created.createdAt,
      );
      await store.transitionStatus('retained-receipt', {
        from: 'running',
        to: 'complete',
        expectCreatedAt: created.createdAt,
        patch: { completedAt: Date.now() },
      });
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await store.getJob('retained-receipt'))?.scheduleOutcomeError).toContain(
        'consent_revoked',
      );
      await store.updateJob('retained-receipt', { status: 'complete' }, created.createdAt);
      await store.clearTerminalHostAction('retained-receipt', created.createdAt);
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: false },
        created.createdAt - 1,
      );
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: false },
        created.createdAt,
      );
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBeGreaterThanOrEqual(0);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify(['retained-receipt', created.createdAt]),
        ),
      ).toBe(0);
    } finally {
      await store.deleteJob('retained-receipt', created.createdAt);
      await redis.quit();
    }
  });

  it('recovers stale owner evidence and indexes post-settlement release across store restarts', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { runningTtl: 1 });
    const stream = 'schedule-outbox-crash';
    const job = await store.createJob(stream, 'owner', stream);
    try {
      await store.enqueueSteer(
        stream,
        { steerId: 'queued', userId: 'owner', text: 'next', createdAt: Date.now() },
        job.createdAt,
      );
      await store.updateJob(
        stream,
        {
          preserveForScheduleReconcile: true,
          scheduleOutcomeError: encoded,
          providerDrained: false,
        },
        job.createdAt,
      );
      await redis.hset(`stream:{${stream}}:job`, 'lastActiveAt', String(Date.now() - 5000));
      const restarted = new RedisJobStore(redis, { runningTtl: 1 });
      const held = await restarted.getScheduleReconcileJobs(100);
      expect(held.find((item) => item.streamId === stream)).toMatchObject({
        status: 'error',
        createdAt: job.createdAt,
        preserveForScheduleReconcile: true,
        providerDrained: false,
      });
      expect((await restarted.getJob(stream))?.scheduleOutcomeError).toContain('consent_revoked');
      expect(JSON.parse((await restarted.claimParkedSteers(stream, 'owner'))!).steers).toEqual(
        expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
      );
      await redis.hset(`stream:{${stream}}:job`, 'completedAt', String(Date.now() - 60_000));
      expect(
        (await restarted.getScheduleReconcileJobs(100)).find((item) => item.streamId === stream)
          ?.providerDrained,
      ).toBe(true);
      // Mongo can already be bookkept. The job's obligation is still discoverable.
      expect(
        (await new RedisJobStore(redis).getScheduleReconcileJobs(100)).map((item) => item.streamId),
      ).toContain(stream);
      await restarted.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
      await restarted.deleteJob(stream, job.createdAt);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, job.createdAt]),
        ),
      ).toBe(0);
      expect(
        (await restarted.getScheduleReconcileJobs(100)).map((item) => item.streamId),
      ).not.toContain(stream);
    } finally {
      await store.deleteJob(stream, job.createdAt);
      await redis.quit();
    }
  });

  it('retires exact deletion and status acknowledgements without removing a successor hint', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis);
    const stream = 'hint-successor';
    try {
      const old = await store.createJob(stream, 'owner');
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, old.createdAt);
      await store.deleteJob(stream, old.createdAt);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, old.createdAt]),
        ),
      ).toBe(0);
      const successor = await store.createJob(stream, 'owner');
      const member = JSON.stringify([stream, successor.createdAt]);
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, successor.createdAt);
      await store.updateJob(stream, { preserveForScheduleReconcile: false }, old.createdAt);
      expect(await store.deleteJob(stream, old.createdAt)).toBe(false);
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
      expect(
        await store.transitionStatus(stream, {
          from: 'running',
          to: 'complete',
          expectCreatedAt: successor.createdAt,
          patch: { completedAt: Date.now(), preserveForScheduleReconcile: false },
        }),
      ).toBe(true);
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
      await store.deleteJob(stream, successor.createdAt);
    } finally {
      await store.deleteJob(stream);
      await redis.quit();
    }
  });

  it.each(['before hash', 'after hash'] as const)(
    'keeps a same-epoch retention re-arm racing release %s',
    async (phase) => {
      const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
      await redis.connect();
      const store = new RedisJobStore(redis);
      const stream = `hint-rearm-${phase}`;
      const job = await store.createJob(stream, 'owner');
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
      try {
        if (phase === 'after hash') {
          const remove = redis.srem.bind(redis);
          jest.spyOn(redis, 'srem').mockImplementationOnce(async (...args) => {
            const result = await remove(...args);
            await store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
            return result;
          });
          await store.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
        } else {
          let arrived!: () => void;
          const entered = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const evaluate = redis.eval.bind(redis);
          jest.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
            arrived();
            await gate;
            return evaluate(...args);
          });
          const retained = store.updateJob(
            stream,
            { preserveForScheduleReconcile: true },
            job.createdAt,
          );
          await entered;
          await store.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
          release();
          await retained;
        }
        expect((await store.getJob(stream))?.preserveForScheduleReconcile).toBe(true);
        expect(
          await redis.sismember(
            'stream:schedule_reconcile:v1',
            JSON.stringify([stream, job.createdAt]),
          ),
        ).toBe(1);
        expect(await redis.ttl(`stream:{${stream}}:job`)).toBe(-1);
      } finally {
        jest.restoreAllMocks();
        await store.deleteJob(stream, job.createdAt);
        await redis.quit();
      }
    },
  );

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
