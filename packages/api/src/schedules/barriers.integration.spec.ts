import Redis from 'ioredis';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { IScheduleRun, IUser } from '@librechat/data-schemas';
import type { IJobStoreV2 } from '~/stream/interfaces/IJobStore';
import type { SchedulesServiceDeps } from './service';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  createMCPRequestContext,
  cleanupMCPRequestContext,
  quiesceMCPRequestContext,
} from '~/mcp/request';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createSchedulesService, recordScheduledMCPToolAuthFailure } from './service';
import { createOAuthMCPServer } from '~/mcp/__tests__/helpers/oauthTestServer';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { attachScheduledMCPBearer, ScheduledMCPBearerError } from './bearer';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPConnection } from '~/mcp/connection';

async function fixture(store: IJobStoreV2 = new InMemoryJobStore({ ttlAfterComplete: 0 })) {
  const mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  const database = new mongoose.Mongoose();
  await database.connect(mongo.getUri(), { autoIndex: false });
  createModels(database);
  const methods = createMethods(database);
  const principal = new database.Types.ObjectId();
  const owner = principal.toString();
  const scheduledFor = new Date('2026-10-04T00:00:00Z');
  const schedule = await methods.createSchedule({
    id: 'barrier',
    user: principal,
    agent_id: 'root',
    name: 'Read',
    prompt: 'Read',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'UTC',
    target: 'new',
    enabled: true,
  });
  await methods.reserveStartedRun({
    scheduleId: schedule.id,
    user: principal,
    scheduledFor,
    conversationId: 'conversation',
    capacitySlot: 0,
  });
  GenerationJobManager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis: store instanceof RedisJobStore,
    cleanupOnComplete: true,
  });
  GenerationJobManager.initialize();
  const job = await GenerationJobManager.createJob('conversation', owner, 'conversation', {
    initialMetadata: {
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
      agent_id: 'root',
    },
  });
  const identity = {
    scheduleId: schedule.id,
    ownerId: owner,
    tenantId: null,
    agentId: 'root',
    invocationMode: 'delegated' as const,
  };
  const dependencies = {
    methods: {
      ...methods,
      getRoleByName: async () => null,
      getFiles: async () => [],
      extendFilesTTL: async () => 0,
    },
    preflightMCP: async () => [],
    getAppConfig: async () => undefined,
    findUserById: async () => null,
    findBalance: async () => null,
    upsertBalance: async () => null,
    initializeNullBalance: async () => null,
    resolveAgentFireAccess: async () => 'ok',
    getChatProject: async () => null,
    isUserDeleting: async () => false,
    enqueueAgentTrigger: async () => undefined,
    getTriggerDelivery: async () => null,
  } satisfies SchedulesServiceDeps;
  const service = createSchedulesService(dependencies, { drainTimeoutMs: 1, drainPollMs: 1 });
  const outcome = {
    scheduleId: schedule.id,
    scheduledFor,
    streamId: job.streamId,
    jobCreatedAt: job.createdAt,
    conversationId: job.streamId,
    status: 'success' as const,
  };
  const close = async () => {
    jest.restoreAllMocks();
    GenerationJobManager.setApprovalExpiredHandler(undefined);
    await GenerationJobManager.destroy({ settlementBudgetMs: 0 });
    await database.disconnect();
    await mongo.stop();
  };
  return {
    database,
    methods,
    owner,
    schedule,
    scheduledFor,
    store,
    job,
    identity,
    service,
    dependencies,
    outcome,
    close,
  };
}

it.each([
  ['delete', 'provider'],
  ['quiesce', 'provider'],
  ['delete', 'persistence'],
  ['quiesce', 'persistence'],
  ['delete', 'host'],
  ['quiesce', 'host'],
] as const)(
  'keeps %s settlement and capacity behind the retained %s barrier',
  async (mode, barrier) => {
    const f = await fixture();
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      if (barrier === 'provider')
        await GenerationJobManager.beginProviderExecution(
          f.job.streamId,
          f.job.createdAt,
          f.job.metadata.providerExecutionId!,
        );
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
      await f.store.cleanup();
      clock.mockRestore();
      if (barrier !== 'provider')
        await f.store.updateJob(
          f.job.streamId,
          {
            ...(barrier === 'persistence'
              ? { terminalPersistencePending: true, terminalPersistenceStartedAt: Date.now() }
              : { terminalHostActionPending: true }),
          },
          f.job.createdAt,
        );
      expect((await f.store.getJob(f.job.streamId))?.status).toBe('error');
      // A failed drain cannot count as delivery, even when its terminal status is already visible.
      const abort = jest.spyOn(f.service.engineDeps, 'abortScheduledJob').mockResolvedValue(false);
      const result =
        mode === 'delete'
          ? await f.service.deleteScheduleForOwner(f.schedule.id, f.owner)
          : await f.service.quiesceUserSchedules(f.owner, 'attempt');
      expect(result).toBe(mode === 'delete' ? 'unconfirmed' : false);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'started' },
      );
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ capacitySlot: 0 });
      if (barrier === 'provider')
        expect((await f.store.getJob(f.job.streamId))?.providerDrained).toBe(false);
      abort.mockRestore();
      if (barrier === 'provider')
        await GenerationJobManager.markProviderExecutionDrained(
          f.job.streamId,
          f.job.createdAt,
          f.job.metadata.providerExecutionId!,
        );
      else
        await f.store.updateJob(
          f.job.streamId,
          { terminalPersistencePending: false, terminalHostActionPending: false },
          f.job.createdAt,
        );
      await f.service.reconcileRetainedJobs();
      expect(
        (
          await f.database
            .model('ScheduleRun')
            .findOne({ scheduleId: f.schedule.id })
            .lean<IScheduleRun>()
        )?.capacitySlot,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
  30_000,
);

it.each(['consent_revoked', 'credential_rejected'] as const)(
  'persists a notification-only %s before disposal and handled-success settlement',
  async (reason) => {
    const f = await fixture();
    const server = await createOAuthMCPServer();
    const context = createMCPRequestContext();
    let connection: MCPConnection | undefined;
    let denied = false;
    let available = false;
    const error = new ScheduledMCPBearerError(reason, 'Files');
    const record = jest.fn(async (failure: ScheduledMCPBearerError) =>
      recordScheduledMCPToolAuthFailure(
        {
          error: failure,
          identity: f.identity,
          streamId: f.job.streamId,
          jobCreatedAt: f.job.createdAt,
          userId: f.owner,
          serverName: 'Files',
        },
        () => f.service.recordMCPToolAuthFailure,
      ),
    );
    try {
      const persist = f.service.engineDeps.methods.recordMCPToolAuthFailure;
      f.service.engineDeps.methods.recordMCPToolAuthFailure = async (input) => {
        if (!available) throw new Error('receipt store unavailable');
        return persist(input);
      };
      server.issuedTokens.add('notification-only');
      server.tokenIssueTimes.set('notification-only', Date.now());
      attachScheduledMCPBearer(
        context,
        f.identity,
        {
          bind: (identity) => ({
            identity,
            reject: () => {},
            resolve: async (input) => {
              if (denied) throw error;
              return { ...input.config, headers: { Authorization: 'Bearer notification-only' } };
            },
          }),
        },
        'invoke',
        undefined,
        { onFailure: record },
      );
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          ephemeralConnection: true,
          useSSRFProtection: false,
        },
        { user: { id: f.owner } as IUser, requestScopedConnections: context },
      );
      context.connections.set('Files', connection);
      await connection.fetchToolsSnapshot();
      if (reason === 'consent_revoked') denied = true;
      else server.issuedTokens.clear();
      await server.notifyToolsChanged();
      const deadline = Date.now() + 2000;
      while (record.mock.calls.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(record).toHaveBeenCalledWith(error);
      expect(Reflect.get(connection, 'shouldStopReconnecting')).toBe(true);
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(false);
      let disposed = false;
      const cleanup = cleanupMCPRequestContext(context).then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      available = true;
      await cleanup;
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(true);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        {
          status: 'error',
          mcp: error.outcomes,
        },
      );
      expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
        enabled: false,
        disabledReason: 'mcp_reauth_required',
        lastRun: { status: 'error', mcp: error.outcomes },
      });
    } finally {
      available = true;
      await connection?.dispose();
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it.each(['delete', 'quiesce'] as const)(
  'keeps %s cleanup abort behind the real pending approval host action',
  async (mode) => {
    const f = await fixture();
    const record = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      await f.store.transitionStatus(f.job.streamId, {
        from: 'running',
        to: 'aborted',
        expectCreatedAt: f.job.createdAt,
        patch: {
          completedAt: Date.now(),
          error: 'Approval expired before a decision was made',
          terminalHostActionPending: true,
        },
      });
      const result =
        mode === 'delete'
          ? await f.service.deleteScheduleForOwner(f.schedule.id, f.owner)
          : await f.service.quiesceUserSchedules(f.owner, 'attempt');
      expect(result).toBe(mode === 'delete' ? 'unconfirmed' : false);
      expect(record).not.toHaveBeenCalled();
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ status: 'started', capacitySlot: 0 });
      expect((await f.store.getJob(f.job.streamId))?.terminalHostActionPending).toBe(true);
      // Only the owning host callback may settle the operation it still owes.
      const acknowledge = jest.fn(async () => {
        const settled = await f.service.recordScheduleOutcome({
          ...f.outcome,
          status: 'interrupted',
        });
        if (!settled) throw new Error('Host settlement deferred');
      });
      GenerationJobManager.setApprovalExpiredHandler(acknowledge);
      await GenerationJobManager['expireStaleApprovals']();
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect((await f.store.getJob(f.job.streamId))?.terminalHostActionPending).not.toBe(true);
      await f.service.reconcileRetainedJobs();
      expect(
        (
          await f.database
            .model('ScheduleRun')
            .findOne({ scheduleId: f.schedule.id })
            .lean<IScheduleRun>()
        )?.capacitySlot,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
  30_000,
);

const redisDescribe = process.env.B2_REDIS_SOCKET ? describe : describe.skip;
redisDescribe('real Redis scheduled provider drain', () => {
  it('holds real Redis schedule evidence and Mongo capacity until the exact provider acknowledges drain', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const f = await fixture(new RedisJobStore(redis));
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      const segment = f.job.metadata.providerExecutionId!;
      await GenerationJobManager.beginProviderExecution(f.job.streamId, f.job.createdAt, segment);
      await f.store.transitionStatus(f.job.streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: f.job.createdAt,
        patch: { completedAt: Date.now() - 60_000, terminalHostActionPending: true },
      });
      const restarted = new RedisJobStore(redis);
      await expect(restarted.hasScheduleCleanupObligation({ scheduleId: 'foreign' })).resolves.toBe(
        false,
      );
      await expect(restarted.hasScheduleCleanupObligation({ userId: f.owner })).resolves.toBe(true);
      await restarted.getTerminalHostActionJobs();
      await restarted.getScheduleReconcileJobs(100);
      await f.service.reconcileRetainedJobs();
      expect((await f.store.getJob(f.job.streamId))?.providerDrained).toBe(false);
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ status: 'started', capacitySlot: 0 });
      expect((await f.store.getJob(f.job.streamId))?.scheduleOutcomeError).toContain(
        'consent_revoked',
      );
      await expect(
        restarted.markProviderExecutionDrained(f.job.streamId, f.job.createdAt, 'wrong-segment'),
      ).resolves.toBe(false);
      await GenerationJobManager.markProviderExecutionDrained(
        f.job.streamId,
        f.job.createdAt,
        segment,
      );
      await f.service.reconcileRetainedJobs();
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'error', mcp: error.outcomes },
      );
      expect(await f.store.getJob(f.job.streamId)).toBeNull();
    } finally {
      await f.close();
      await redis.quit();
    }
  }, 30_000);
});

it.each([401, 403] as const)(
  'records an automatic SDK SSE HTTP %s without another catalog or tool call',
  async (status) => {
    const f = await fixture();
    let reject = false;
    let dispatched = 0;
    const server = await createOAuthMCPServer({
      onResourceRequest: () => {
        dispatched++;
      },
      resourceFailure: (req) => (reject && req.method === 'GET' ? status : undefined),
    });
    const context = createMCPRequestContext();
    let connection: MCPConnection | undefined;
    const retire = jest.fn();
    const resolve = jest.fn(async (input) => ({
      ...input.config,
      headers: { Authorization: 'Bearer automatic-only' },
    }));
    const record = jest.fn(async (error: ScheduledMCPBearerError) =>
      recordScheduledMCPToolAuthFailure(
        {
          error,
          identity: f.identity,
          streamId: f.job.streamId,
          jobCreatedAt: f.job.createdAt,
          userId: f.owner,
          serverName: 'Files',
        },
        () => f.service.recordMCPToolAuthFailure,
      ),
    );
    try {
      server.issuedTokens.add('automatic-only');
      server.tokenIssueTimes.set('automatic-only', Date.now());
      attachScheduledMCPBearer(
        context,
        f.identity,
        { bind: (identity) => ({ identity, resolve, reject: retire }) },
        'invoke',
        undefined,
        { onFailure: record },
      );
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          useSSRFProtection: false,
          ephemeralConnection: true,
        },
        { user: { id: f.owner } as IUser, requestScopedConnections: context },
      );
      context.connections.set('Files', connection);
      const transport = Reflect.get(connection, 'transport');
      const recover = jest.spyOn(transport, '_startOrAuthSse');
      Reflect.set(transport, '_reconnectionOptions', {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 1,
      });
      reject = true;
      transport._scheduleReconnection({ resumptionToken: undefined });
      const deadline = Date.now() + 2000;
      while (record.mock.calls.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: expect.objectContaining({
            reason: 'credential_rejected',
            recovery: 'authorize',
          }),
        }),
      );
      expect(recover).toHaveBeenCalled();
      await expect(recover.mock.results[0].value).rejects.toMatchObject({
        failure: { reason: 'credential_rejected' },
      });
      expect(retire).toHaveBeenCalledWith('Files');
      expect(Reflect.get(connection, 'shouldStopReconnecting')).toBe(true);
      const requests = dispatched;
      await cleanupMCPRequestContext(context);
      expect(dispatched).toBe(requests + 1); // The exempt session DELETE is teardown, not replay.
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(true);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'error', mcp: [expect.objectContaining({ reason: 'credential_rejected' })] },
      );
    } finally {
      await connection?.dispose();
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it('retains the terminal host obligation across failed acknowledgement and a new service instance', async () => {
  const f = await fixture();
  try {
    await f.service.recordMCPToolAuthFailure({
      error: new ScheduledMCPBearerError('consent_revoked', 'Files'),
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      userId: f.owner,
      serverName: 'Files',
    });
    await f.store.transitionStatus(f.job.streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: f.job.createdAt,
      patch: {
        completedAt: Date.now(),
        error: 'Approval expired before a decision was made',
        terminalHostActionPending: true,
      },
    });
    await f.methods.markScheduleDeleting(f.schedule.id, f.owner);
    const clear = jest
      .spyOn(f.store, 'clearTerminalHostAction')
      .mockRejectedValue(new Error('marker write unavailable'));
    GenerationJobManager.setApprovalExpiredHandler(async () => {
      if (!(await f.service.recordScheduleOutcome({ ...f.outcome, status: 'interrupted' })))
        throw new Error('Settlement deferred');
    });
    await GenerationJobManager['expireStaleApprovals']();
    const held = await f.store.getJob(f.job.streamId);
    expect(held).toMatchObject({
      terminalHostActionPending: true,
      preserveForScheduleReconcile: true,
    });
    expect(
      await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
    ).toMatchObject({ status: 'error' });
    expect(await f.database.model('Schedule').findOne({ id: f.schedule.id }).lean()).not.toBeNull();
    const restarted = createSchedulesService(f.dependencies, { drainTimeoutMs: 1, drainPollMs: 1 });
    expect((await f.methods.getActiveRunsForUser(f.owner)).length).toBe(0);
    await expect(restarted.engineDeps.eraseSettledSchedule!(f.schedule.id)).resolves.toBe(false);
    await expect(restarted.quiesceUserSchedules(f.owner, 'attempt')).resolves.toBe(false);
    clear.mockRestore();
    await GenerationJobManager['expireStaleApprovals']();
    await restarted.reconcileRetainedJobs();
    expect(await f.store.getJob(f.job.streamId)).toBeNull();
    await expect(restarted.quiesceUserSchedules(f.owner, 'attempt')).resolves.toBe(true);
    expect(await f.database.model('Schedule').findOne({ id: f.schedule.id }).lean()).toBeNull();
  } finally {
    await f.close();
  }
}, 30_000);

it('drains an automatic rejection received during completion before the Mongo terminal write', async () => {
  const f = await fixture();
  let reject = false;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = await createOAuthMCPServer({
    resourceFailure: async (req) => {
      if (!reject || req.method !== 'GET') return;
      entered();
      await gate;
      return 401;
    },
  });
  const context = createMCPRequestContext();
  let connection: MCPConnection | undefined;
  const record = jest.fn((error: ScheduledMCPBearerError) =>
    f.service.recordMCPToolAuthFailure({
      error,
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      userId: f.owner,
      serverName: 'Files',
    }),
  );
  try {
    server.issuedTokens.add('completion-only');
    server.tokenIssueTimes.set('completion-only', Date.now());
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity) => ({
          identity,
          reject: () => {},
          resolve: async (input) => ({
            ...input.config,
            headers: { Authorization: 'Bearer completion-only' },
          }),
        }),
      },
      'invoke',
      undefined,
      { onFailure: record },
    );
    const quiesce = jest.fn(async () => {
      await quiesceMCPRequestContext(context);
    });
    f.service.registerMCPSettlement({
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      quiesce,
    });
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    connection = await MCPConnectionFactory.create(
      {
        serverName: 'Files',
        serverConfig: definition,
        ephemeralConnection: true,
        useSSRFProtection: false,
      },
      { user: { id: f.owner } as IUser, requestScopedConnections: context },
    );
    context.connections.set('Files', connection);
    const transport = Reflect.get(connection, 'transport');
    reject = true;
    const reopening = transport
      ._startOrAuthSse({ resumptionToken: undefined })
      .catch((error: Error) => error);
    await started;
    await f.store.updateJob(
      f.job.streamId,
      { status: 'complete', completedAt: Date.now() },
      f.job.createdAt,
    );
    const writes = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
    const settlement = f.service.recordScheduleOutcome(f.outcome);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const writtenBeforeDrain = writes.mock.calls.length;
    release();
    await reopening;
    const settled = await settlement;
    expect(writtenBeforeDrain).toBe(0);
    expect(settled).toBe(true);
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalled();
    expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject({
      status: 'error',
      mcp: [expect.objectContaining({ reason: 'credential_rejected' })],
    });
    await expect(transport._startOrAuthSse({ resumptionToken: undefined })).rejects.toThrow();
  } finally {
    release();
    await connection?.dispose().catch(() => undefined);
    await cleanupMCPRequestContext(context);
    MCPConnection.clearCooldown('Files');
    await server.close();
    await f.close();
  }
}, 30_000);

it('tears down a real session after a fenced receipt without touching its successor', async () => {
  const f = await fixture();
  let denied = false;
  const server = await createOAuthMCPServer({
    resourceFailure: (req) => (denied && req.method === 'GET' ? 401 : undefined),
  });
  const context = createMCPRequestContext();
  let connection: MCPConnection | undefined;
  try {
    server.issuedTokens.add('retired-only');
    server.tokenIssueTimes.set('retired-only', Date.now());
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity) => ({
          identity,
          reject: () => {},
          resolve: async (input) => ({
            ...input.config,
            headers: { Authorization: 'Bearer retired-only' },
          }),
        }),
      },
      'invoke',
      undefined,
      {
        onFailure: (error) =>
          recordScheduledMCPToolAuthFailure(
            {
              error,
              identity: f.identity,
              streamId: f.job.streamId,
              jobCreatedAt: f.job.createdAt,
              userId: f.owner,
              serverName: 'Files',
            },
            () => f.service.recordMCPToolAuthFailure,
          ),
      },
    );
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    connection = await MCPConnectionFactory.create(
      {
        serverName: 'Files',
        serverConfig: definition,
        ephemeralConnection: true,
        useSSRFProtection: false,
      },
      { user: { id: f.owner } as IUser, requestScopedConnections: context },
    );
    context.connections.set('Files', connection);
    await f.store.deleteJob(f.job.streamId, f.job.createdAt);
    const successor = await GenerationJobManager.createJob(f.job.streamId, f.owner, f.job.streamId);
    denied = true;
    const transport = Reflect.get(connection, 'transport');
    await expect(transport._startOrAuthSse({ resumptionToken: undefined })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const terminate = jest.spyOn(transport, 'terminateSession');
    const close = jest.spyOn(connection.client, 'close');
    await expect(connection.dispose()).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(Reflect.get(connection, 'agents')).toHaveLength(0);
    expect((await f.store.getJob(f.job.streamId))?.createdAt).toBe(successor.createdAt);
    expect((await f.store.getJob(f.job.streamId))?.scheduleOutcomeError).toBeUndefined();
  } finally {
    await connection?.dispose().catch(() => undefined);
    await cleanupMCPRequestContext(context);
    MCPConnection.clearCooldown('Files');
    await server.close();
    await f.close();
  }
}, 30_000);
