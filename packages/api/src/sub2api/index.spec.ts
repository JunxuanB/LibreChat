import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createSub2API } from './index';

const secret = 'persistent-test-identity-secret-32-characters';
const fingerprint = (key: string) =>
  createHmac('sha256', secret).update('sub2api:').update(key).digest('hex');

function fixture(options: { enabled?: boolean; ttl?: number } = {}) {
  const config: AppConfig = {
    config: {
      version: '1.3.5',
      sub2api: {
        enabled: options.enabled ?? true,
        baseURL: 'http://gateway.invalid',
        publicURL: 'http://site.invalid',
        validationTtlMs: options.ttl ?? 30000,
      },
    },
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
  };
  const fetchMock = jest
    .fn<Promise<Response>, [string, RequestInit?]>()
    .mockImplementation(async () => new Response('{}', { status: 200 }));
  const getOrCreateSub2APIUser = jest.fn(async (identity: string) => ({
    id: identity,
    provider: 'sub2api',
    sub2apiIdentity: identity,
  }));
  const updateUserKey = jest.fn(async () => undefined);
  const getUserKeyValues = jest.fn(async () => ({ apiKey: 'key-a' }));
  const integration = createSub2API({
    getAppConfig: async () => config,
    identitySecret: secret,
    request: fetchMock,
    getOrCreateSub2APIUser,
    updateUserKey,
    getUserKeyValues,
  });
  const app = express();
  app.use(express.json());
  app.post(
    '/login',
    integration.authenticate((_req, res) => {
      res.status(418).end();
    }),
    (req, res) => {
      res.json(req.user);
    },
  );
  app.use((req, _res, next) => {
    req.user = { id: 'user-a', provider: 'sub2api', sub2apiIdentity: fingerprint('key-a') };
    next();
  });
  app.use(integration.authorize);
  app.get('/api/convos', (_req, res) => {
    res.json(['chat-a']);
  });
  app.put('/api/keys', (_req, res) => {
    res.sendStatus(201);
  });
  app.post('/api/agents/chat', (_req, res) => {
    res.sendStatus(200);
  });
  return { app, integration, fetchMock, getOrCreateSub2APIUser, updateUserKey, getUserKeyValues };
}

describe('sub2api Token authentication', () => {
  it('validates upstream before provisioning and stores the encrypted-key input only for its owner', async () => {
    const f = fixture();
    const first = await request(f.app).post('/login').send({ password: ' key-a ' }).expect(200);
    const second = await request(f.app).post('/login').send({ password: 'key-a' }).expect(200);
    const third = await request(f.app).post('/login').send({ password: 'key-b' }).expect(200);
    expect(first.body.id).toBe(second.body.id);
    expect(third.body.id).not.toBe(first.body.id);
    expect(JSON.stringify(first.body)).not.toContain('key-a');
    expect(f.fetchMock).toHaveBeenCalledWith(
      'http://gateway.invalid/v1/usage',
      expect.objectContaining({
        headers: { Authorization: 'Bearer key-a' },
        redirect: 'error',
      }),
    );
    expect(f.updateUserKey).toHaveBeenCalledWith({
      userId: fingerprint('key-a'),
      name: 'sub2api',
      value: JSON.stringify({ apiKey: 'key-a' }),
    });
  });

  it.each([401, 403, 500, 429])(
    'does not create a user when upstream returns %s',
    async (status) => {
      const f = fixture();
      f.fetchMock.mockResolvedValue(new Response('secret upstream diagnostics key-a', { status }));
      const response = await request(f.app).post('/login').send({ password: 'key-a' });
      expect(response.status).toBe(status < 500 && status !== 429 ? 401 : 503);
      expect(f.getOrCreateSub2APIUser).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain('secret');
    },
  );

  it('rejects malformed keys without contacting the gateway', async () => {
    const f = fixture();
    await request(f.app)
      .post('/login')
      .send({ password: { apiKey: 'key-a' } })
      .expect(400);
    await request(f.app)
      .post('/login')
      .send({ password: 'x'.repeat(8193) })
      .expect(400);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on a gateway timeout and never exposes submitted content', async () => {
    const f = fixture();
    f.fetchMock.mockRejectedValue(new Error('key-a secret body'));
    const response = await request(f.app).post('/login').send({ password: 'key-a' }).expect(503);
    expect(response.body.code).toBe('SUB2API_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('key-a');
  });

  it('coalesces repeated authenticated reads and rechecks a disabled key after its bounded cache', async () => {
    const f = fixture({ ttl: 1 });
    await request(f.app).get('/api/convos').expect(200);
    f.fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await request(f.app).get('/api/convos').expect(401);
    expect(response.body.code).toBe('SUB2API_INVALID_KEY');
  });

  it('reuses validation and credential reads inside the cache window', async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: 4 }, () => request(f.app).get('/api/convos').expect(200)),
    );
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.getUserKeyValues).toHaveBeenCalledTimes(1);
  });

  it('rejects swapping credentials into an existing history space', async () => {
    const f = fixture();
    f.getUserKeyValues.mockResolvedValue({ apiKey: 'key-b' });
    await request(f.app).get('/api/convos').expect(401);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('blocks generic key mutations and other API providers', async () => {
    const f = fixture();
    const result = await request(f.app)
      .put('/api/keys')
      .send({ name: 'sub2api', value: 'key-b' })
      .expect(403);
    expect(result.body.code).toBe('SUB2API_SWITCH_KEY_REQUIRED');
    await request(f.app).post('/api/agents/chat').send({ endpoint: 'openAI' }).expect(403);
    await request(f.app).post('/api/agents/chat').send({ endpoint: 'sub2api' }).expect(200);
  });

  it('keeps the upstream login flow available when integration is disabled', async () => {
    const f = fixture({ enabled: false });
    await request(f.app).post('/login').send({ password: 'local-password' }).expect(418);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('synchronizes safe public branding and disables independent registrations', async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            site_name: '氛围土豆',
            site_subtitle: '欢迎',
            site_logo: 'javascript:alert(1)',
            admin_token: 'secret',
          },
        }),
      ),
    );
    const data = await f.integration.startup();
    expect(data.appTitle).toBe('氛围土豆');
    expect(data.registrationEnabled).toBe(false);
    expect(data.sub2api?.logo).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('secret');
    await f.integration.startup();
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
});
