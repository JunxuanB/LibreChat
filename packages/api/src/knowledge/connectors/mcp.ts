import { requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  mimeType?: string;
}

function resourceContent(
  value: unknown,
): Pick<import('./types').KnowledgeSourceItem, 'content' | 'binaryContent'> {
  if (!value || typeof value !== 'object') return { content: '' };
  const contents = (value as { contents?: Array<{ text?: string; blob?: string }> }).contents ?? [];
  const text = contents
    .map((item) => item.text)
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
  if (text) return { content: text };
  const buffers = contents
    .map((item) => item.blob)
    .filter((item): item is string => typeof item === 'string')
    .map((blob) => Buffer.from(blob, 'base64'));
  if (buffers.length === 0) return { content: '' };
  const binaryContent = Buffer.concat(buffers);
  if (binaryContent.byteLength > 20 * 1024 * 1024) {
    throw new Error('MCP resource exceeds the 20971520 byte limit');
  }
  return { binaryContent };
}

export const mcpKnowledgeConnector: KnowledgeConnector = {
  manifest: {
    type: 'mcp',
    name: 'MCP Resources',
    description: 'Index resources exposed by a configured MCP server.',
    category: 'advanced',
    capabilities: [],
    fields: [{ key: 'serverName', label: 'MCP server', type: 'text', required: true }],
  },

  async validate(request, context) {
    if (!context.callMcp) throw new Error('MCP resource access is not configured');
    await context.callMcp(
      requiredString(request.config, 'serverName'),
      'resources/list',
      {},
      request.signal,
    );
  },

  async sync(request, context) {
    if (!context.callMcp) throw new Error('MCP resource access is not configured');
    const serverName = requiredString(request.config, 'serverName');
    const changes: KnowledgeSourceChange[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > 1000) throw new Error('MCP pagination exceeds 1000 pages');
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('MCP pagination repeated a cursor');
        seenCursors.add(cursor);
      }
      const listed = (await context.callMcp(
        serverName,
        'resources/list',
        cursor ? { cursor } : {},
        request.signal,
      )) as { resources?: McpResource[]; nextCursor?: string };
      for (const resource of listed.resources ?? []) {
        const result = await context.callMcp(
          serverName,
          'resources/read',
          { uri: resource.uri },
          request.signal,
        );
        changes.push({
          operation: 'upsert',
          item: {
            externalId: resource.uri,
            title: resource.title ?? resource.name ?? resource.uri,
            ...resourceContent(result),
            mimeType: resource.mimeType,
            canonicalUrl: resource.uri,
            metadata: { serverName },
          },
        });
      }
      cursor = listed.nextCursor;
    } while (cursor);
    return { changes, cursor: new Date().toISOString(), snapshot: true };
  },
};
