import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPConnection } from '~/mcp/connection';
import { mcpKnowledgeConnector } from './mcp';

describe('MCP knowledge resource integration', () => {
  test('syncs paginated resources through a real SDK session and closes it', async () => {
    const server = new Server(
      { name: 'knowledge-resources', version: '1.0.0' },
      { capabilities: { resources: {} } },
    );
    server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) =>
      params?.cursor
        ? { resources: [{ uri: 'kb://two', name: 'Two', mimeType: 'text/plain' }] }
        : {
            resources: [{ uri: 'kb://one', name: 'One', title: 'One', mimeType: 'text/plain' }],
            nextCursor: 'page-2',
          },
    );
    server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
      contents: [{ uri: params.uri, text: `content for ${params.uri}` }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const connection = new MCPConnection({
      serverName: 'knowledge-resources',
      serverConfig: { type: 'streamable-http', url: 'https://mcp.example.test' },
    });
    await connection.client.connect(clientTransport);
    const close = jest.spyOn(connection.client, 'close');

    try {
      const context = {
        fetch: jest.fn() as unknown as typeof fetch,
        assertSafeUrl: jest.fn(async () => undefined),
        callMcp: async (
          _serverName: string,
          method: 'resources/list' | 'resources/read',
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) =>
          method === 'resources/list'
            ? connection.listResources(
                typeof params.cursor === 'string' ? params.cursor : undefined,
                signal,
              )
            : connection.readResource(String(params.uri), signal),
      };

      await mcpKnowledgeConnector.validate(
        { config: { serverName: 'knowledge-resources' } },
        context,
      );
      const result = await mcpKnowledgeConnector.sync(
        { config: { serverName: 'knowledge-resources' } },
        context,
      );

      expect(result.changes).toEqual([
        expect.objectContaining({
          operation: 'upsert',
          item: expect.objectContaining({
            externalId: 'kb://one',
            title: 'One',
            content: 'content for kb://one',
          }),
        }),
        expect.objectContaining({
          operation: 'upsert',
          item: expect.objectContaining({
            externalId: 'kb://two',
            title: 'Two',
            content: 'content for kb://two',
          }),
        }),
      ]);
    } finally {
      await connection.client.close();
      await server.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });
});
