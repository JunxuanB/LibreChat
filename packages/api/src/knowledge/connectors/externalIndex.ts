import {
  assertHttpUrl,
  expectOk,
  optionalString,
  readResponseContent,
  requiredString,
  safeFetch,
} from './helpers';
import type { KnowledgeConnector, KnowledgeSourceItem } from './types';

export const MAX_EXTERNAL_INDEX_RESPONSE_BYTES: number = 2 * 1024 * 1024;
export const MAX_EXTERNAL_INDEX_RESULTS: number = 50;

const requestHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

export const externalIndexConnector: KnowledgeConnector = {
  manifest: {
    type: 'external_index',
    name: 'External Index',
    description: 'Delegate retrieval to an HTTP search endpoint.',
    category: 'advanced',
    capabilities: ['external_retrieval'],
    fields: [
      { key: 'url', label: 'Search endpoint', type: 'url', required: true },
      {
        key: 'accessToken',
        label: 'Bearer token',
        type: 'password',
        secret: true,
      },
    ],
  },

  async validate(request, context) {
    const url = assertHttpUrl(requiredString(request.config, 'url'));
    const token = optionalString(request.credentials, 'accessToken');
    let response = await safeFetch(context, url, {
      method: 'HEAD',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: request.signal,
    });
    if (response.status === 405 || response.status === 501) {
      response = await safeFetch(context, url, {
        method: 'POST',
        headers: requestHeaders(token),
        body: JSON.stringify({ query: '', limit: 1 }),
        signal: request.signal,
      });
    }
    await expectOk(response, 'External index');
  },

  async sync() {
    return { changes: [] };
  },

  async query(request, context) {
    const url = assertHttpUrl(requiredString(request.config, 'url'));
    const token = optionalString(request.credentials, 'accessToken');
    const response = await expectOk(
      await safeFetch(context, url, {
        method: 'POST',
        headers: requestHeaders(token),
        body: JSON.stringify({
          query: request.query,
          limit: request.limit ?? 10,
        }),
        signal: request.signal,
      }),
      'External index',
    );
    const { content = '' } = await readResponseContent(
      response,
      'application/json',
      MAX_EXTERNAL_INDEX_RESPONSE_BYTES,
    );
    const payload = JSON.parse(content) as {
      results?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(payload.results)) return [];
    if (payload.results.length > MAX_EXTERNAL_INDEX_RESULTS) {
      throw new Error(`External index returned more than ${MAX_EXTERNAL_INDEX_RESULTS} results`);
    }
    const limit = Math.min(Math.max(request.limit ?? 10, 1), MAX_EXTERNAL_INDEX_RESULTS);
    return payload.results.slice(0, limit).map<KnowledgeSourceItem>((result) => {
      if (
        typeof result.id !== 'string' ||
        typeof result.title !== 'string' ||
        typeof result.content !== 'string'
      ) {
        throw new Error('External index results require string id, title, and content fields');
      }
      return {
        externalId: result.id.slice(0, 512),
        title: result.title.slice(0, 500),
        content: result.content,
        canonicalUrl: typeof result.url === 'string' ? result.url : undefined,
        metadata: result,
      };
    });
  },
};
