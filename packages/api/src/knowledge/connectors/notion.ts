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
  const visitedParents = new Set<string>();
  const output: string[] = [];
  let blockCount = 0;
  let pageCount = 0;
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    if (visitedParents.has(parent)) continue;
    visitedParents.add(parent);
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      pageCount += 1;
      if (pageCount > 10_000) throw new Error('Notion pagination exceeds 10000 pages');
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('Notion pagination repeated a cursor');
        seenCursors.add(cursor);
      }
      const url = new URL(
        `https://api.notion.com/v1/blocks/${encodeURIComponent(parent)}/children`,
      );
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('start_cursor', cursor);
      const payload = (await (
        await expectOk(await context.fetch(url, { headers, signal }), 'Notion')
      ).json()) as {
        results?: NotionBlock[];
        has_more?: boolean;
        next_cursor?: string;
      };
      for (const block of payload.results ?? []) {
        blockCount += 1;
        if (blockCount > 10_000) throw new Error('Notion source exceeds the 10000 block limit');
        const text = richText(block);
        if (text) output.push(text);
        if (block.has_children) queue.push(block.id);
      }
      if (payload.has_more && !payload.next_cursor) {
        throw new Error('Notion pagination omitted its next cursor');
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
    setup: 'manual_credentials',
    capabilities: [],
    fields: [
      { key: 'pageId', label: 'Root page ID', type: 'text', required: true },
      {
        key: 'accessToken',
        label: 'Integration token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Create a Notion integration, share the root page with it, and paste its integration token.',
      },
    ],
  },

  async validate(request, context) {
    const pageId = requiredString(request.config, 'pageId');
    await expectOk(
      await context.fetch(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
        headers: {
          ...bearerHeaders(request),
          'Notion-Version': '2022-06-28',
        },
        signal: request.signal,
      }),
      'Notion',
    );
  },

  async sync(request, context) {
    const pageId = requiredString(request.config, 'pageId');
    const headers = {
      ...bearerHeaders(request),
      'Notion-Version': '2022-06-28',
    };
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
      snapshot: true,
    };
  },
};
