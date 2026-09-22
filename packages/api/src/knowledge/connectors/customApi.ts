import { assertHttpUrl, expectOk, optionalString, requiredString, safeFetch } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange, KnowledgeSourceItem } from './types';

interface CustomApiPayload {
  items?: Array<Record<string, unknown>>;
  deleted?: string[];
  cursor?: string;
}

function parseItem(value: Record<string, unknown>): KnowledgeSourceItem {
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.content !== 'string'
  ) {
    throw new Error('Custom API items require string id, title, and content fields');
  }
  return {
    externalId: value.id,
    title: value.title,
    content: value.content,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType : 'text/plain',
    canonicalUrl: typeof value.url === 'string' ? value.url : undefined,
    revision: typeof value.revision === 'string' ? value.revision : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    metadata:
      value.metadata && typeof value.metadata === 'object'
        ? (value.metadata as Record<string, unknown>)
        : undefined,
  };
}

export const customApiConnector: KnowledgeConnector = {
  manifest: {
    type: 'custom_api',
    name: 'Custom API',
    description: 'Synchronize a JSON document feed.',
    category: 'advanced',
    capabilities: ['incremental_sync', 'deletions'],
    fields: [
      { key: 'url', label: 'Feed URL', type: 'url', required: true },
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
    await expectOk(
      await safeFetch(context, url, {
        method: 'HEAD',
        headers: optionalString(request.credentials, 'accessToken')
          ? { Authorization: `Bearer ${request.credentials?.accessToken}` }
          : undefined,
        signal: request.signal,
      }),
      'Custom API',
    );
  },

  async sync(request, context) {
    const url = assertHttpUrl(requiredString(request.config, 'url'));
    if (request.cursor) {
      url.searchParams.set('cursor', request.cursor);
    }
    const token = optionalString(request.credentials, 'accessToken');
    const response = await expectOk(
      await safeFetch(context, url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: request.signal,
      }),
      'Custom API',
    );
    const payload = (await response.json()) as CustomApiPayload;
    const changes: KnowledgeSourceChange[] = (payload.items ?? []).map((item) => ({
      operation: 'upsert',
      item: parseItem(item),
    }));
    for (const externalId of payload.deleted ?? []) {
      changes.push({ operation: 'delete', externalId });
    }
    return { changes, cursor: payload.cursor };
  },
};
