import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { backfillSearchTokens, warnOnMissingSearchTokens } from './searchTokens';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  jest.clearAllMocks();
});

const users = () => mongoose.connection.db!.collection('users');
const groups = () => mongoose.connection.db!.collection('groups');

describe('backfillSearchTokens', () => {
  it('backfills users and groups across tenants in batches and is idempotent', async () => {
    await users().insertMany([
      { name: 'Ana Lima', email: 'ana@x.io', username: 'ana', tenantId: 'tenant-a' },
      { name: 'Ben Ode', email: 'ben@y.io', tenantId: 'tenant-b' },
      { email: 'noname@z.io' },
      {
        name: 'Already Done',
        email: 'done@z.io',
        nameTokens: ['already', 'done'],
        emailTokens: ['done@z.io', 'done', 'z', 'io'],
        usernameTokens: [],
      },
    ]);
    await groups().insertMany([{ name: 'Core Team', source: 'local' }]);

    const result = await backfillSearchTokens(mongoose.connection, { batchSize: 2 });
    expect(result).toEqual({
      pending: { users: 3, groups: 1 },
      updated: { users: 3, groups: 1 },
    });

    const ana = await users().findOne({ email: 'ana@x.io' });
    expect(ana).toMatchObject({
      tenantId: 'tenant-a',
      nameTokens: ['ana', 'lima'],
      emailTokens: ['ana@x.io', 'ana', 'x', 'io'],
      usernameTokens: ['ana'],
    });
    expect(await users().findOne({ email: 'noname@z.io' })).toMatchObject({
      nameTokens: [],
      usernameTokens: [],
    });
    expect(await groups().findOne({ name: 'Core Team' })).toMatchObject({
      nameTokens: ['core', 'team'],
      emailTokens: [],
    });

    await expect(backfillSearchTokens(mongoose.connection)).resolves.toEqual({
      pending: { users: 0, groups: 0 },
      updated: { users: 0, groups: 0 },
    });
  });

  it('completes documents that a partial update tokenized for only one field', async () => {
    await users().insertOne({ name: 'Part Ial', email: 'p@x.io', emailTokens: ['p@x.io'] });
    await backfillSearchTokens(mongoose.connection);
    expect(await users().findOne({ email: 'p@x.io' })).toMatchObject({
      nameTokens: ['part', 'ial'],
      emailTokens: ['p@x.io', 'p', 'x', 'io'],
    });
  });

  it('writes nothing on a dry run', async () => {
    await users().insertOne({ name: 'Dry Run', email: 'dry@x.io' });
    await expect(backfillSearchTokens(mongoose.connection, { dryRun: true })).resolves.toEqual({
      pending: { users: 1, groups: 0 },
      updated: { users: 0, groups: 0 },
    });
    expect(await users().findOne({ email: 'dry@x.io' })).not.toHaveProperty('nameTokens');
  });
});

describe('warnOnMissingSearchTokens', () => {
  it('warns only while documents lack tokens', async () => {
    await users().insertOne({ name: 'Old User', email: 'old@x.io' });
    await expect(warnOnMissingSearchTokens(mongoose.connection)).resolves.toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('migrate:search-tokens'));

    jest.clearAllMocks();
    await backfillSearchTokens(mongoose.connection);
    await expect(warnOnMissingSearchTokens(mongoose.connection)).resolves.toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
