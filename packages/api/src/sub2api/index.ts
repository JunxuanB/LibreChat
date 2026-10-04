import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { extractEnvVariable, configSchema } from 'librechat-data-provider';
import type { Request, Response as HttpResponse, NextFunction, RequestHandler } from 'express';
import type { TStartupConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

type Config = z.infer<typeof configSchema>['sub2api'];
type IdentityUser = {
  id: string;
  provider: string;
  sub2apiIdentity?: string;
};
type Validation = { ok: true } | { ok: false; status: number; code: string };

interface Dependencies {
  getAppConfig: () => Promise<AppConfig>;
  identitySecret: string;
  request: (input: string, init?: RequestInit) => Promise<Response>;
  getOrCreateSub2APIUser: (identity: string) => Promise<IdentityUser>;
  updateUserKey: (params: { userId: string; name: string; value: string }) => Promise<unknown>;
  getUserKeyValues: (params: { userId: string; name: string }) => Promise<Record<string, string>>;
}

interface Integration {
  authenticate: (fallback: RequestHandler) => RequestHandler;
  authorize: (req: Request, res: HttpResponse, next: NextFunction) => Promise<void>;
  startup: () => Promise<Partial<TStartupConfig>>;
}

const settingsSchema = z.object({
  data: z.object({
    site_name: z.string().max(200).optional(),
    site_subtitle: z.string().max(500).optional(),
    site_logo: z.string().max(700000).optional(),
  }),
});
const keySchema = z.object({ password: z.string().trim().min(1).max(8192) });
const identitySchema = z.object({
  id: z.string().min(1),
  provider: z.literal('sub2api'),
  sub2apiIdentity: z.string().regex(/^[a-f0-9]{64}$/),
});

function resolveURL(value: string): string {
  const url = new URL(extractEnvVariable(value));
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid sub2api URL');
  }
  return url.toString().replace(/\/$/, '');
}

/** Only operator-configured URLs are used; client requests cannot select a provider. */
export function createSub2API(deps: Dependencies): Integration {
  const validations = new Map<string, { expiresAt: number; promise: Promise<Validation> }>();
  const credentials = new Map<
    string,
    { expiresAt: number; promise: Promise<Record<string, string>> }
  >();
  let settings:
    | { expiresAt: number; promise: Promise<z.infer<typeof settingsSchema>['data']> }
    | undefined;

  const getConfig = async (): Promise<Config> => {
    const config = (await deps.getAppConfig()).config.sub2api;
    return configSchema.shape.sub2api.parse(config);
  };
  const fingerprint = (key: string): string => {
    if (deps.identitySecret.length < 32) {
      throw new Error('sub2api identity secret must be at least 32 characters');
    }
    return createHmac('sha256', deps.identitySecret).update('sub2api:').update(key).digest('hex');
  };
  const sendFailure = (res: HttpResponse, status: number, code: string) =>
    res.status(status).json({ code, message: code });

  const validate = async (
    key: string,
    config: NonNullable<Config>,
    force = false,
  ): Promise<Validation> => {
    const baseURL = resolveURL(config.baseURL);
    const cacheKey = `${baseURL}:${fingerprint(key)}`;
    const cached = validations.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
    const promise = (async (): Promise<Validation> => {
      try {
        const response = await deps.request(`${baseURL}/v1/usage`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error',
        });
        await response.body?.cancel();
        if (response.ok) {
          return { ok: true };
        }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, status: 401, code: 'SUB2API_INVALID_KEY' };
        }
        return { ok: false, status: 503, code: 'SUB2API_UNAVAILABLE' };
      } catch {
        return { ok: false, status: 503, code: 'SUB2API_UNAVAILABLE' };
      }
    })();
    if (validations.size >= config.cacheLimit) {
      const oldest = validations.keys().next().value;
      if (oldest) validations.delete(oldest);
    }
    validations.set(cacheKey, { promise, expiresAt: Date.now() + config.validationTtlMs });
    const result = await promise;
    if (!result.ok) validations.delete(cacheKey);
    return result;
  };

  const authenticate =
    (fallback: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        const config = await getConfig();
        if (!config?.enabled) return fallback(req, res, next);
        const parsed = keySchema.safeParse(req.body);
        if (!parsed.success) {
          sendFailure(res, 400, 'SUB2API_INVALID_KEY');
          return;
        }
        const key = parsed.data.password;
        const result = await validate(key, config, true);
        if (!result.ok) {
          sendFailure(res, result.status, result.code);
          return;
        }
        const user = await deps.getOrCreateSub2APIUser(fingerprint(key));
        await deps.updateUserKey({
          userId: user.id,
          name: 'sub2api',
          value: JSON.stringify({ apiKey: key }),
        });
        credentials.delete(user.id);
        req.user = user;
        next();
      } catch {
        sendFailure(res, 503, 'SUB2API_UNAVAILABLE');
      }
    };

  const authorize = async (req: Request, res: HttpResponse, next: NextFunction): Promise<void> => {
    try {
      const config = await getConfig();
      if (!config?.enabled) return next();
      const parsedUser = identitySchema.safeParse(req.user);
      if (!parsedUser.success) {
        sendFailure(res, 401, 'SUB2API_INVALID_KEY');
        return;
      }
      const user = parsedUser.data;
      let credential = credentials.get(user.id);
      if (!credential || credential.expiresAt <= Date.now()) {
        if (credentials.size >= config.cacheLimit) {
          const oldest = credentials.keys().next().value;
          if (oldest) credentials.delete(oldest);
        }
        credential = {
          expiresAt: Date.now() + config.validationTtlMs,
          promise: deps.getUserKeyValues({ userId: user.id, name: 'sub2api' }),
        };
        credentials.set(user.id, credential);
      }
      let values: Record<string, string>;
      try {
        values = await credential.promise;
      } catch {
        credentials.delete(user.id);
        throw new Error('Credential unavailable');
      }
      const identity = values.apiKey ? fingerprint(values.apiKey) : '';
      if (
        identity.length !== user.sub2apiIdentity.length ||
        !timingSafeEqual(Buffer.from(identity), Buffer.from(user.sub2apiIdentity))
      ) {
        sendFailure(res, 401, 'SUB2API_INVALID_KEY');
        return;
      }
      const result = await validate(values.apiKey, config);
      if (!result.ok) {
        sendFailure(res, result.status, result.code);
        return;
      }
      const path = req.originalUrl.split('?')[0];
      if (path.startsWith('/api/keys') && !['GET', 'HEAD'].includes(req.method)) {
        sendFailure(res, 403, 'SUB2API_SWITCH_KEY_REQUIRED');
        return;
      }
      if (req.body?.endpoint && !['sub2api', 'agents'].includes(req.body.endpoint)) {
        sendFailure(res, 403, 'SUB2API_PROVIDER_DISABLED');
        return;
      }
      next();
    } catch {
      sendFailure(res, 503, 'SUB2API_UNAVAILABLE');
    }
  };

  const startup = async (): Promise<Partial<TStartupConfig>> => {
    const config = await getConfig();
    if (!config?.enabled) return {};
    const baseURL = resolveURL(config.baseURL);
    let publicSettings: z.infer<typeof settingsSchema>['data'] = {};
    try {
      if (!settings || settings.expiresAt <= Date.now()) {
        const promise = deps
          .request(`${baseURL}/api/v1/settings/public`, {
            signal: AbortSignal.timeout(config.timeoutMs),
            redirect: 'error',
          })
          .then(async (response) => {
            if (!response.ok) throw new Error('Settings unavailable');
            return settingsSchema.parse(await response.json()).data;
          });
        settings = { promise, expiresAt: Date.now() + config.settingsTtlMs };
      }
      publicSettings = await settings.promise;
    } catch {
      settings = undefined;
    }
    const logo = publicSettings.site_logo;
    return {
      ...(publicSettings.site_name ? { appTitle: publicSettings.site_name } : {}),
      emailLoginEnabled: true,
      registrationEnabled: false,
      socialLoginEnabled: false,
      passwordResetEnabled: false,
      discordLoginEnabled: false,
      facebookLoginEnabled: false,
      githubLoginEnabled: false,
      googleLoginEnabled: false,
      appleLoginEnabled: false,
      openidLoginEnabled: false,
      samlLoginEnabled: false,
      sub2api: {
        enabled: true,
        siteUrl: resolveURL(config.publicURL),
        subtitle: publicSettings.site_subtitle,
        logo:
          logo && /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(logo)
            ? logo
            : undefined,
      },
    };
  };

  return { authenticate, authorize, startup };
}
