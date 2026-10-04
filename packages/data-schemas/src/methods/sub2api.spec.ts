import mongoose from 'mongoose';
import { SystemRoles } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createSub2APIMethods } from './sub2api';
import userSchema from '../schema/user';

describe('sub2api identity persistence', () => {
  let server: MongoMemoryServer;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    mongoose.model('User', userSchema);
    await mongoose.models.User.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('gives simultaneous first logins one user and never grants administrator privileges', async () => {
    const methods = createSub2APIMethods(mongoose);
    const users = await Promise.all(
      Array.from({ length: 8 }, () => methods.getOrCreateSub2APIUser('a'.repeat(64))),
    );
    expect(new Set(users.map((user) => user.id)).size).toBe(1);
    expect(users.every((user) => user.role === SystemRoles.USER)).toBe(true);
    expect(await mongoose.models.User.countDocuments()).toBe(1);
    const other = await methods.getOrCreateSub2APIUser('b'.repeat(64));
    expect(other.id).not.toBe(users[0].id);
    expect(Object.keys(other)).not.toContain('password');
  });
});
