import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createKnowledgeBaseMethods } from './knowledgeBase';

describe('knowledge source sync leases', () => {
  let server: MongoMemoryServer;
  let database: mongoose.Mongoose;
  let models: ReturnType<typeof createModels>;
  let methods: ReturnType<typeof createKnowledgeBaseMethods>;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    models = createModels(database);
    methods = createKnowledgeBaseMethods(database, { removeAllPermissions: jest.fn() });
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await models.KnowledgeSource.deleteMany({});
  });

  const createSource = async () => {
    const knowledgeBaseId = new database.Types.ObjectId();
    const source = await models.KnowledgeSource.create({
      knowledgeBaseId,
      owner: new database.Types.ObjectId(),
      tenantId: 'tenant-1',
      name: 'Docs',
      type: 'website',
      config: {},
    });
    return { knowledgeBaseId: String(knowledgeBaseId), sourceId: String(source._id) };
  };

  it('atomically acquires, contends, and permits takeover after expiration', async () => {
    const ids = await createSource();
    const now = new Date('2026-09-22T12:00:00.000Z');
    expect(
      await methods.acquireKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'run-one',
        now,
        expiresAt: new Date(now.getTime() + 1000),
      }),
    ).toBe(true);
    expect(
      await methods.renewKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'run-one',
        now: new Date(now.getTime() + 500),
        expiresAt: new Date(now.getTime() + 2000),
      }),
    ).toBe(true);
    expect(
      await methods.acquireKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'run-two',
        now,
        expiresAt: new Date(now.getTime() + 1000),
      }),
    ).toBe(false);
    expect(
      await methods.acquireKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'run-two',
        now: new Date(now.getTime() + 1001),
        expiresAt: new Date(now.getTime() + 3000),
      }),
    ).toBe(false);
    expect(
      await methods.acquireKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'run-two',
        now: new Date(now.getTime() + 2001),
        expiresAt: new Date(now.getTime() + 3000),
      }),
    ).toBe(true);
    expect(
      await methods.updateKnowledgeSourceSyncStateIfLeaseOwner(ids.sourceId, 'run-one', {
        syncStatus: 'ready',
        cursor: 'stale-cursor',
      }),
    ).toBe(false);
    expect((await models.KnowledgeSource.findById(ids.sourceId).lean())?.cursor).toBeUndefined();
  });

  it('only lets the owning token release and never selects lease state by default', async () => {
    const ids = await createSource();
    const now = new Date();
    await methods.acquireKnowledgeSourceSyncLease({
      ...ids,
      tenantId: 'tenant-1',
      token: 'owner-token',
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    expect(
      await methods.releaseKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'different-token',
      }),
    ).toBe(false);
    expect(
      (await methods.getKnowledgeSourceForSync(ids.knowledgeBaseId, ids.sourceId))?.syncLease,
    ).toBe(undefined);
    expect(
      await methods.releaseKnowledgeSourceSyncLease({
        ...ids,
        tenantId: 'tenant-1',
        token: 'owner-token',
      }),
    ).toBe(true);
  });
});
