import { assertHttpUrl, expectOk, optionalString, requiredString, safeFetch } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceItem } from './types';

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
    await expectOk(
      await safeFetch(context, url, {
        method: 'HEAD',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: request.signal,
      }),
      'External index',
    );
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
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          query: request.query,
          limit: request.limit ?? 10,
        }),
        signal: request.signal,
      }),
      'External index',
    );
    const payload = (await response.json()) as {
      results?: Array<Record<string, unknown>>;
    };
    return (payload.results ?? []).map<KnowledgeSourceItem>((result) => {
      if (
        typeof result.id !== 'string' ||
        typeof result.title !== 'string' ||
        typeof result.content !== 'string'
      ) {
        throw new Error('External index results require string id, title, and content fields');
      }
      return {
        externalId: result.id,
        title: result.title,
        content: result.content,
        canonicalUrl: typeof result.url === 'string' ? result.url : undefined,
        metadata: result,
      };
    });
  },
};
