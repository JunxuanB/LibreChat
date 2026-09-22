import {
  assertHttpUrl,
  expectOk,
  requiredString,
  safeFetch,
  sameOriginUrl,
  textFromHtml,
} from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

export const confluenceConnector: KnowledgeConnector = {
  manifest: {
    type: 'confluence',
    name: 'Confluence',
    description: 'Index pages from a Confluence Cloud space.',
    category: 'app',
    setup: 'manual_credentials',
    capabilities: [],
    fields: [
      { key: 'baseUrl', label: 'Confluence URL', type: 'url', required: true },
      { key: 'spaceId', label: 'Space ID', type: 'text', required: true },
      {
        key: 'accessToken',
        label: 'OAuth access token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Paste a valid Confluence token. Use Edit source to rotate it before it expires.',
      },
    ],
  },

  async validate(request, context) {
    const base = assertHttpUrl(requiredString(request.config, 'baseUrl'));
    const spaceId = requiredString(request.config, 'spaceId');
    await expectOk(
      await safeFetch(
        context,
        new URL(`/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}`, base),
        {
          headers: {
            Authorization: `Bearer ${requiredString(request.credentials, 'accessToken')}`,
          },
          signal: request.signal,
        },
      ),
      'Confluence',
    );
  },

  async sync(request, context) {
    const base = assertHttpUrl(requiredString(request.config, 'baseUrl'));
    const spaceId = requiredString(request.config, 'spaceId');
    const headers = {
      Authorization: `Bearer ${requiredString(request.credentials, 'accessToken')}`,
    };
    const changes: KnowledgeSourceChange[] = [];
    let nextUrl: URL | undefined = new URL(
      `/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&body-format=storage&limit=100`,
      base,
    );
    const seenPages = new Set<string>();
    let pageCount = 0;
    while (nextUrl) {
      pageCount += 1;
      if (pageCount > 1000) throw new Error('Confluence pagination exceeds 1000 pages');
      if (seenPages.has(nextUrl.toString())) {
        throw new Error('Confluence pagination repeated a page');
      }
      seenPages.add(nextUrl.toString());
      const payload = (await (
        await expectOk(
          await safeFetch(context, nextUrl, {
            headers,
            signal: request.signal,
          }),
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
      nextUrl = payload._links?.next
        ? sameOriginUrl(payload._links.next, base, 'Confluence pagination URL')
        : undefined;
    }
    return { changes, cursor: new Date().toISOString(), snapshot: true };
  },
};
