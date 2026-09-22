import { customApiConnector, createDefaultKnowledgeConnectorRegistry, websiteConnector } from '.';

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, ...init });
}

describe('knowledge connectors', () => {
  test('publishes only registered connector manifests', () => {
    expect(createDefaultKnowledgeConnectorRegistry().manifests().map(({ type }) => type)).toEqual([
      'website',
      'github',
      'google_drive',
      'sharepoint',
      'notion',
      'confluence',
      'postgresql',
      'custom_api',
      'mcp',
      'external_index',
    ]);
  });

  test('normalizes a website into a source item', async () => {
    const fetch = jest.fn(async () =>
      response('<html><head><title>Docs</title></head><body><h1>Hello</h1></body></html>', {
        headers: { etag: 'v1', 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const result = await websiteConnector.sync(
      { config: { url: 'https://example.com/docs' } },
      { fetch: fetch as typeof globalThis.fetch },
    );
    expect(result.changes[0]).toMatchObject({
      operation: 'upsert',
      item: {
        externalId: 'https://example.com/docs',
        title: 'Docs',
        content: 'Docs Hello',
        revision: 'v1',
      },
    });
  });

  test('passes a custom API cursor and normalizes deletions', async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify({
          items: [{ id: '1', title: 'One', content: 'Body' }],
          deleted: ['2'],
          cursor: 'next',
        }),
      ),
    );
    const result = await customApiConnector.sync(
      { config: { url: 'https://api.example.com/feed' }, cursor: 'old' },
      { fetch: fetch as typeof globalThis.fetch },
    );
    expect(fetch.mock.calls[0][0].toString()).toBe('https://api.example.com/feed?cursor=old');
    expect(result).toMatchObject({
      cursor: 'next',
      changes: [{ operation: 'upsert' }, { operation: 'delete', externalId: '2' }],
    });
  });
});
