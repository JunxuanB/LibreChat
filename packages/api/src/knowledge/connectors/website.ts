import {
  assertHttpUrl,
  expectOk,
  requiredString,
  safeFetch,
  textFromHtml,
  titleFromHtml,
} from './helpers';
import type { KnowledgeConnector } from './types';

const MAX_PAGES = 100;

function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]);
}

export const websiteConnector: KnowledgeConnector = {
  manifest: {
    type: 'website',
    name: 'Website',
    description: 'Index one page or the URLs in a sitemap.',
    category: 'web',
    capabilities: [],
    fields: [
      { key: 'url', label: 'Page or sitemap URL', type: 'url', required: true },
      {
        key: 'maxPages',
        label: 'Maximum pages',
        type: 'number',
        placeholder: String(MAX_PAGES),
      },
    ],
  },

  async validate(request, context) {
    const url = assertHttpUrl(requiredString(request.config, 'url'));
    await expectOk(
      await safeFetch(context, url, { method: 'HEAD', signal: request.signal }),
      'Website',
    );
  },

  async sync(request, context) {
    const root = assertHttpUrl(requiredString(request.config, 'url'));
    const rootResponse = await expectOk(
      await safeFetch(context, root, { signal: request.signal }),
      'Website',
    );
    const rootBody = await rootResponse.text();
    const isSitemap = root.pathname.endsWith('.xml') || /<urlset\b|<sitemapindex\b/i.test(rootBody);
    const configuredLimit = Number(request.config.maxPages ?? MAX_PAGES);
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(MAX_PAGES, configuredLimit))
      : MAX_PAGES;
    const urls = isSitemap ? sitemapLocations(rootBody).slice(0, limit) : [root.toString()];
    const changes = [];

    for (const value of urls) {
      const url = assertHttpUrl(value, 'sitemap URL');
      const response =
        url.toString() === root.toString()
          ? rootResponse
          : await expectOk(
              await safeFetch(context, url, { signal: request.signal }, 'sitemap URL'),
              'Website',
            );
      const html = url.toString() === root.toString() ? rootBody : await response.text();
      const revision =
        response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined;
      changes.push({
        operation: 'upsert' as const,
        item: {
          externalId: url.toString(),
          title: titleFromHtml(html, url.pathname.split('/').filter(Boolean).pop() ?? url.hostname),
          content: textFromHtml(html),
          mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'text/html',
          canonicalUrl: url.toString(),
          revision,
        },
      });
    }

    return { changes, cursor: new Date().toISOString(), snapshot: true };
  },
};
