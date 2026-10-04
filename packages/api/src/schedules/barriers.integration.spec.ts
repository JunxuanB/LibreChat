import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { IScheduleRun, IUser } from '@librechat/data-schemas';
import type { SchedulesServiceDeps } from './service';
import type { ParsedServerConfig } from '~/mcp/types';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createSchedulesService, recordScheduledMCPToolAuthFailure } from './service';
import { createMCPRequestContext, cleanupMCPRequestContext } from '~/mcp/request';
import { createOAuthMCPServer } from '~/mcp/__tests__/helpers/oauthTestServer';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { attachScheduledMCPBearer, ScheduledMCPBearerError } from './bearer';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPConnection } from '~/mcp/connection';

async function fixture() {
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
  const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
  GenerationJobManager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
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
  const service = createSchedulesService(
    {
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
    } satisfies SchedulesServiceDeps,
    { drainTimeoutMs: 1, drainPollMs: 1 },
  );
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
