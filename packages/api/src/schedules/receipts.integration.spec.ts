import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { SchedulesServiceDeps } from './service';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { createSchedulesService } from './service';
import { ScheduledMCPBearerError } from './bearer';

it('releases a volatile retained job after Mongo settled its admitted denial and cleanup failed', async () => {
  const mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  const database = new mongoose.Mongoose();
  const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
  try {
    await database.connect(mongo.getUri(), { autoIndex: false });
    createModels(database);
    const methods = createMethods(database);
    const principal = new database.Types.ObjectId();
    const owner = principal.toString();
    const schedule = await methods.createSchedule({
      id: 'cleanup-retry',
      user: principal,
      name: 'Files',
      prompt: 'Read files',
      agent_id: 'root',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'UTC',
      target: 'new',
      enabled: true,
    });
    const scheduledFor = new Date('2026-10-03T12:00:00.000Z');
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
      isRedis: false,
      cleanupOnComplete: true,
    });
    GenerationJobManager.initialize();
    const service = createSchedulesService({
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
    } satisfies SchedulesServiceDeps);
    const job = await GenerationJobManager.createJob('conversation', owner, 'conversation', {
      initialMetadata: {
        scheduleId: schedule.id,
        scheduledFor: scheduledFor.toISOString(),
        agent_id: 'root',
      },
    });
    const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
    await expect(
      service.recordMCPToolAuthFailure({
        error,
        streamId: job.streamId,
        jobCreatedAt: job.createdAt,
        userId: owner,
        serverName: 'Files',
        identity: {
          scheduleId: schedule.id,
          ownerId: owner,
          tenantId: null,
          agentId: 'root',
          invocationMode: 'delegated',
        },
      }),
    ).resolves.toBe(true);
    await store.updateJob(
      job.streamId,
      { status: 'complete', completedAt: Date.now() },
      job.createdAt,
    );
    // The fallback settles directly through the repository, without clearing local pending evidence.
    await methods.recordRunOutcome({
      scheduleId: schedule.id,
      scheduledFor,
      status: 'success',
      autoDisableAfterFailures: 5,
    });
    expect((await methods.getRunsForReconciliation(new Date(), 100)).length).toBe(0);
    expect((await methods.getUnbookkeptRuns(new Date(), 100)).length).toBe(0);
    const update = store.updateJob.bind(store);
    const failRelease = jest.spyOn(store, 'updateJob').mockImplementation(async (...args) => {
      if (args[1].preserveForScheduleReconcile === false) throw new Error('release unavailable');
      return update(...args);
    });
    await expect(
      service.engineDeps.clearReconciledJob(job.streamId, {
        scheduleId: schedule.id,
        scheduledFor,
        createdAt: job.createdAt,
      }),
    ).rejects.toThrow('release unavailable');
    failRelease.mockRestore();
    await service.reconcileRetainedJobs();
    expect(await store.getJob(job.streamId)).toBeNull();
    await expect(store.createJob(job.streamId, owner)).resolves.toMatchObject({
      status: 'running',
    });
    const durable = await methods.getScheduleRunAbortState(schedule.id, scheduledFor);
    expect(durable).toMatchObject({ status: 'error', mcp: error.outcomes });
  } finally {
    jest.restoreAllMocks();
    await GenerationJobManager.destroy();
    await database.disconnect();
    await mongo.stop();
  }
}, 30_000);
