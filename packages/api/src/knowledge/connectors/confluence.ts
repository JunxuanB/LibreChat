import { assertHttpUrl, expectOk, requiredString, textFromHtml } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

export const confluenceConnector: KnowledgeConnector = {
  manifest: {
    type: 'confluence',
    name: 'Confluence',
    description: 'Index pages from a Confluence Cloud space.',
    category: 'app',
    capabilities: ['incremental_sync', 'deletions'],
    fields: [
      { key: 'baseUrl', label: 'Confluence URL', type: 'url', required: true },
      { key: 'spaceId', label: 'Space ID', type: 'text', required: true },
      { key: 'accessToken', label: 'OAuth or API token', type: 'password', secret: true, required: true },
    ],
  },

  async validate(request, context) {
    const base = assertHttpUrl(requiredString(request.config, 'baseUrl'));
    const spaceId = requiredString(request.config, 'spaceId');
    await expectOk(
      await context.fetch(new URL(`/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}`, base), {
        headers: { Authorization: `Bearer ${requiredString(request.credentials, 'accessToken')}` },
        signal: request.signal,
      }),
      'Confluence',
    );
  },

  async sync(request, context) {
    const base = assertHttpUrl(requiredString(request.config, 'baseUrl'));
    const spaceId = requiredString(request.config, 'spaceId');
    const headers = { Authorization: `Bearer ${requiredString(request.credentials, 'accessToken')}` };
    const changes: KnowledgeSourceChange[] = [];
    let nextUrl: URL | undefined = new URL(
      `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&body-format=storage&limit=100`,
      base,
    );
    while (nextUrl) {
      const payload = (await (
        await expectOk(
          await context.fetch(nextUrl, { headers, signal: request.signal }),
          'Confluence',
        )
      ).json()) as {
        results?: Array<{
          id: string;
          title: string;
          version?: { number?: number; createdAt?: string };
          body?: { storage?: { value?: string } };
          _links?: { webui?: string };
        }>;
        _links?: { next?: string };
      };
      for (const page of payload.results ?? []) {
        changes.push({
          operation: 'upsert',
          item: {
            externalId: page.id,
            title: page.title,
            content: textFromHtml(page.body?.storage?.value ?? ''),
            mimeType: 'text/plain',
            canonicalUrl: page._links?.webui
              ? new URL(page._links.webui, base).toString()
              : undefined,
            revision: page.version?.number?.toString(),
            updatedAt: page.version?.createdAt,
            metadata: { spaceId },
          },
        });
      }
      nextUrl = payload._links?.next ? new URL(payload._links.next, base) : undefined;
    }
    return { changes, cursor: new Date().toISOString() };
  },
};
