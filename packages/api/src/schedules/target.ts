import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '../mcp/types';
import { OboTokenResolutionError } from '../mcp/oauth/obo';
import { getMissingCustomUserVars } from '../mcp/utils';
import { processMCPEnv } from '../utils/env';

/** Resolve only the destination, using the runtime's user/custom-variable rules.
 * Request/session credentials cannot define a stable unattended destination. */
export function resolveScheduledOboServer(
  server: ParsedServerConfig,
  user: IUser,
  customUserVars?: Record<string, string>,
): ParsedServerConfig {
  if (
    !server.url ||
    /\{\{LIBRECHAT_(?:BODY_|OPENID_|GRAPH_)/.test(server.url) ||
    getMissingCustomUserVars(server, customUserVars).length > 0
  )
    throw new OboTokenResolutionError(
      'missing_upstream_provider',
      'This server has no stable unattended destination.',
    );
  const resolved = processMCPEnv({
    options: { type: 'streamable-http', url: server.url, dbId: server.dbId, source: server.source },
    user,
    customUserVars,
  });
  if (!('url' in resolved) || /\{\{|\$\{/.test(resolved.url))
    throw new OboTokenResolutionError(
      'missing_upstream_provider',
      'This server has no stable unattended destination.',
    );
  let endpoint: URL;
  try {
    endpoint = new URL(resolved.url);
  } catch {
    throw new OboTokenResolutionError(
      'missing_upstream_provider',
      'This server has no supported unattended destination.',
    );
  }
  if (
    !['https:', 'http:', 'wss:', 'ws:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new OboTokenResolutionError(
      'missing_upstream_provider',
      'This server has no supported unattended destination.',
    );
  return { ...server, url: resolved.url };
}
