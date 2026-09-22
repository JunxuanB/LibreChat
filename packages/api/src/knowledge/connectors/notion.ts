import { bearerHeaders, expectOk, requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

function richText(block: NotionBlock): string {
  const value = block[block.type];
  if (!value || typeof value !== 'object') return '';
  const parts = (value as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
  return (parts ?? []).map(({ plain_text }) => plain_text ?? '').join('');
}

async function readBlocks(
  pageId: string,
  headers: Record<string, string>,
  context: Parameters<KnowledgeConnector['sync']>[1],
  signal?: AbortSignal,
): Promise<string> {
  const queue = [pageId];
  const output: string[] = [];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    let cursor: string | undefined;
    do {
      const url = new URL(`https://api.notion.com/v1/blocks/${encodeURIComponent(parent)}/children`);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('start_cursor', cursor);
      const payload = (await (
        await expectOk(await context.fetch(url, { headers, signal }), 'Notion')
      ).json()) as { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string };
      for (const block of payload.results ?? []) {
        const text = richText(block);
        if (text) output.push(text);
        if (block.has_children) queue.push(block.id);
      }
      cursor = payload.has_more ? payload.next_cursor : undefined;
    } while (cursor);
  }
  return output.join('\n\n');
}

export const notionConnector: KnowledgeConnector = {
  manifest: {
    type: 'notion',
    name: 'Notion',
    description: 'Index a Notion page tree shared with an integration.',
    category: 'app',
    capabilities: ['incremental_sync'],
    fields: [
      { key: 'pageId', label: 'Root page ID', type: 'text', required: true },
      { key: 'accessToken', label: 'Integration token', type: 'password', secret: true, required: true },
    ],
  },

  async validate(request, context) {
    const pageId = requiredString(request.config, 'pageId');
    await expectOk(
      await context.fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
        headers: { ...bearerHeaders(request), 'Notion-Version': '2022-06-28' },
        signal: request.signal,
      }),
      'Notion',
    );
  },

  async sync(request, context) {
    const pageId = requiredString(request.config, 'pageId');
    const headers = { ...bearerHeaders(request), 'Notion-Version': '2022-06-28' };
    const response = await expectOk(
      await context.fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
        headers,
        signal: request.signal,
      }),
      'Notion',
    );
    const page = (await response.json()) as {
      id: string;
      url?: string;
      last_edited_time?: string;
      properties?: Record<string, { title?: Array<{ plain_text?: string }> }>;
    };
    const title =
      Object.values(page.properties ?? {})
        .flatMap(({ title: values }) => values ?? [])
        .map(({ plain_text }) => plain_text ?? '')
        .join('') || 'Notion page';
    const content = await readBlocks(pageId, headers, context, request.signal);
    return {
      changes: [
        {
          operation: 'upsert',
          item: {
            externalId: page.id,
            title,
            content,
            mimeType: 'text/plain',
            canonicalUrl: page.url,
            revision: page.last_edited_time,
            updatedAt: page.last_edited_time,
          },
        },
      ],
      cursor: page.last_edited_time,
    };
  },
};
