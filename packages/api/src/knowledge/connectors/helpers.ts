import type { KnowledgeSyncRequest } from './types';

export function requiredString(
  values: Record<string, unknown> | undefined,
  key: string,
): string {
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
  return url;
}
