import { SystemRoles } from 'librechat-data-provider';

export interface Sub2APIIdentityUser {
  _id: string;
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  username: string;
  provider: string;
  role: string;
  sub2apiIdentity: string;
}

/** An atomic identity upsert keeps simultaneous first logins in one chat space. */
export function createSub2APIMethods(mongoose: typeof import('mongoose')): {
  getOrCreateSub2APIUser: (identity: string) => Promise<Sub2APIIdentityUser>;
} {
  return {
    async getOrCreateSub2APIUser(identity: string): Promise<Sub2APIIdentityUser> {
      if (!/^[a-f0-9]{64}$/.test(identity)) {
        throw new Error('Invalid sub2api identity');
      }
      const user = await mongoose.models.User.findOneAndUpdate(
        { sub2apiIdentity: identity },
        {
          $setOnInsert: {
            sub2apiIdentity: identity,
            email: `${identity}@sub2api.invalid`,
            emailVerified: true,
            name: 'API Key',
            username: `key-${identity.slice(0, 8)}`,
            provider: 'sub2api',
            role: SystemRoles.USER,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (!user || user.provider !== 'sub2api') {
        throw new Error('Invalid sub2api user');
      }
      const id = user._id.toString();
      return {
        _id: id,
        id,
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name,
        username: user.username,
        provider: user.provider,
        role: user.role,
        sub2apiIdentity: user.sub2apiIdentity,
      };
    },
  };
}
