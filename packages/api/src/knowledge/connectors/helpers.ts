import { isIP } from 'node:net';
import type { KnowledgeConnectorContext, KnowledgeSyncRequest } from './types';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_CONTENT_BYTES = 20 * 1024 * 1024;

export function requiredString(values: Record<string, unknown> | undefined, key: string): string {
  const value = values?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required connector value: ${key}`);
  }
  return value.trim();
}

export function optionalString(
  values: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = values?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function bearerHeaders(request: KnowledgeSyncRequest, credentialKey = 'accessToken') {
  const token = requiredString(request.credentials, credentialKey);
  return { Authorization: `Bearer ${token}` };
}

export async function expectOk(response: Response, service: string): Promise<Response> {
  if (response.ok) {
    return response;
  }
  const detail = (await response.text()).slice(0, 300);
  throw new Error(`${service} request failed (${response.status}): ${detail}`);
}

export function textFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromHtml(html: string, fallback: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? textFromHtml(match[1]).slice(0, 300) || fallback : fallback;
}

export function assertHttpUrl(value: string, field = 'url'): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${field} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${field} must not contain credentials`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isDisallowedIp(hostname)
  ) {
    throw new Error(`${field} must not target a local or private address`);
  }
  return url;
}

function isDisallowedIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const [a, b] = hostname.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    return (
      hostname === '::' ||
      hostname === '::1' ||
      /^f[cd]/i.test(hostname) ||
      /^fe[89ab]/i.test(hostname) ||
      /^::ffff:(?:0*:)*?(?:7f|a|ac1[0-9a-f]|c0a8)/i.test(hostname)
    );
  }
  return false;
}

export async function safeFetch(
  context: KnowledgeConnectorContext,
  input: string | URL,
  init: RequestInit = {},
  field = 'url',
): Promise<Response> {
  let url = assertHttpUrl(input.toString(), field);
  let method = init.method?.toUpperCase() ?? 'GET';

  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    await context.assertSafeUrl(url, init.signal ?? undefined);
    const requestInit = { ...init, method, redirect: 'manual' as const };
    if (method === 'GET' || method === 'HEAD') {
      delete requestInit.body;
    }
    const response = await context.fetch(url, requestInit);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }
    if (redirectCount === 5) {
      throw new Error('Too many redirects');
    }
    const redirectUrl = assertHttpUrl(new URL(location, url).toString(), 'redirect URL');
    const headers = new Headers(init.headers);
    if (
      redirectUrl.origin !== url.origin &&
      (headers.has('authorization') || headers.has('cookie') || headers.has('proxy-authorization'))
    ) {
      throw new Error('Authenticated connector requests must not redirect to another origin');
    }
    url = redirectUrl;
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
    }
  }

  throw new Error('Too many redirects');
}

export function sameOriginUrl(value: string, origin: URL, field = 'pagination URL'): URL {
  const url = assertHttpUrl(new URL(value, origin).toString(), field);
  if (url.origin !== origin.origin) {
    throw new Error(`${field} must stay on ${origin.origin}`);
  }
  return url;
}

export async function readResponseContent(
  response: Response,
  mimeType: string | undefined,
  maxBytes = DEFAULT_MAX_CONTENT_BYTES,
): Promise<Pick<import('./types').KnowledgeSourceItem, 'content' | 'binaryContent'>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Connector content exceeds the ${maxBytes} byte limit`);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Connector content exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const normalizedMime = mimeType?.split(';')[0].trim().toLowerCase();
  const isText =
    normalizedMime?.startsWith('text/') === true ||
    normalizedMime === 'application/json' ||
    normalizedMime === 'application/xml' ||
    normalizedMime === 'application/xhtml+xml' ||
    normalizedMime?.endsWith('+json') === true ||
    normalizedMime?.endsWith('+xml') === true;
  return isText
    ? { content: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
    : { binaryContent: bytes };
}
