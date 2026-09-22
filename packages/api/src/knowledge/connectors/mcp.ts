import { requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  mimeType?: string;
}

function contentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const contents = (value as { contents?: Array<{ text?: string; blob?: string }> }).contents ?? [];
  return contents.map((item) => item.text ?? item.blob ?? '').join('\n');
}

export const mcpKnowledgeConnector: KnowledgeConnector = {
  manifest: {
    type: 'mcp',
    name: 'MCP Resources',
    description: 'Index resources exposed by a configured MCP server.',
    category: 'advanced',
    capabilities: ['incremental_sync'],
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
    const listed = (await context.callMcp(
      serverName,
      'resources/list',
      {},
      request.signal,
    )) as { resources?: McpResource[] };
    const changes: KnowledgeSourceChange[] = [];
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
          content: contentText(result),
          mimeType: resource.mimeType,
          canonicalUrl: resource.uri,
          metadata: { serverName },
        },
      });
    }
    return { changes, cursor: new Date().toISOString() };
  },
};
