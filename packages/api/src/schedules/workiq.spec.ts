import type { IToken, TokenMethods } from '@librechat/data-schemas';
import type { OAuthClientInformation } from '../mcp/oauth';
import type { ParsedServerConfig } from '../mcp/types';
import { hasRenewableWorkIqAuthorization, isScheduledWorkIqOAuthConfig } from './mcp';
import { MCPTokenStorage } from '../mcp/oauth';

const server: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://workiq.svc.cloud.microsoft/mcp',
  oauth: {
    client_id: 'app',
    client_secret: 'secret',
    authorization_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    scope: 'api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask offline_access',
  },
};

const token = (generation: string, expiresAt: Date) =>
  ({
    metadata: new Map([['credential_set_id', generation]]),
    expiresAt,
  }) as IToken;

it('permits a Work IQ-bound offline grant even if the access token has expired', async () => {
  const future = new Date(Date.now() + 24 * 60 * 60_000);
  const past = new Date(Date.now() - 12 * 60 * 60_000);
  const records = new Map([
    ['mcp_oauth', token('grant-1', past)],
    ['mcp_oauth_refresh', token('grant-1', future)],
  ]);
  const findToken = jest.fn(
    async ({ type }) => records.get(type ?? '') ?? null,
  ) as TokenMethods['findToken'];
  const readClient = jest.spyOn(MCPTokenStorage, 'getClientInfoAndMetadata').mockResolvedValue({
    clientInfo: {
      client_id: 'app',
      client_secret: 'secret',
      scope: server.oauth!.scope,
    } as OAuthClientInformation,
    clientMetadata: {
      credential_set_id: 'grant-1',
      server_url: server.url,
      token_endpoint: server.oauth!.token_url,
      client_source: 'configured',
    },
  });
  try {
    expect(isScheduledWorkIqOAuthConfig(server)).toBe(true);
    await expect(
      hasRenewableWorkIqAuthorization('owner', 'WorkIQ', server, findToken),
    ).resolves.toBe(true);
    records.set('mcp_oauth', token('rotated', past));
    await expect(
      hasRenewableWorkIqAuthorization('owner', 'WorkIQ', server, findToken),
    ).rejects.toThrow('OAuth token storage is unavailable');
    records.delete('mcp_oauth');
    records.set('mcp_oauth_refresh', token('grant-1', past));
    await expect(
      hasRenewableWorkIqAuthorization('owner', 'WorkIQ', server, findToken),
    ).resolves.toBe(false);
    records.set('mcp_oauth_refresh', token('grant-1', future));
    readClient.mockResolvedValueOnce({
      clientInfo: {
        client_id: 'app',
        client_secret: 'secret',
        scope: 'offline_access',
      } as OAuthClientInformation,
      clientMetadata: { credential_set_id: 'grant-1' },
    });
    await expect(
      hasRenewableWorkIqAuthorization('owner', 'WorkIQ', server, findToken),
    ).resolves.toBe(false);
  } finally {
    readClient.mockRestore();
  }
});

it('does not turn storage outages into a missing-consent diagnosis', async () => {
  const findToken = jest.fn(async () => {
    throw new Error('database unavailable');
  }) as TokenMethods['findToken'];
  const readClient = jest
    .spyOn(MCPTokenStorage, 'getClientInfoAndMetadata')
    .mockResolvedValue(null);
  try {
    await expect(
      hasRenewableWorkIqAuthorization('owner', 'WorkIQ', server, findToken),
    ).rejects.toThrow('database unavailable');
  } finally {
    readClient.mockRestore();
  }
});

it('rejects a browser-login-style OBO server or a different authorization endpoint', () => {
  expect(isScheduledWorkIqOAuthConfig({ ...server, obo: { scopes: 'read' } })).toBe(false);
  expect(isScheduledWorkIqOAuthConfig({ ...server, source: 'user' })).toBe(false);
  expect(
    isScheduledWorkIqOAuthConfig({
      ...server,
      oauth: {
        ...server.oauth,
        token_url: 'https://login.microsoftonline.com/other/oauth2/v2.0/token',
      },
    }),
  ).toBe(false);
});
