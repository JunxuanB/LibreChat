import {
  customApiConnector,
  createDefaultKnowledgeConnectorRegistry,
  googleDriveConnector,
  postgresqlConnector,
  websiteConnector,
} from '.';
import { assertHttpUrl, safeFetch } from './helpers';

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, ...init });
}

describe('knowledge connectors', () => {
  const assertSafeUrl = jest.fn(async () => undefined);

  beforeEach(() => {
    assertSafeUrl.mockClear();
  });

  test('publishes only registered connector manifests', () => {
    expect(
      createDefaultKnowledgeConnectorRegistry()
        .manifests()
        .map(({ type }) => type),
    ).toEqual([
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
      { fetch: fetch as typeof globalThis.fetch, assertSafeUrl },
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
      { fetch: fetch as typeof globalThis.fetch, assertSafeUrl },
    );
    const requestedUrl = (fetch.mock.calls as unknown[][])[0]?.[0];
    expect(String(requestedUrl)).toBe('https://api.example.com/feed?cursor=old');
    expect(result).toMatchObject({
      cursor: 'next',
      changes: [{ operation: 'upsert' }, { operation: 'delete', externalId: '2' }],
    });
  });

  test.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/',
    'http://[::1]/',
    'http://service.internal/',
    'https://user:password@example.com/',
  ])('rejects an unsafe literal URL: %s', (url) => {
    expect(() => assertHttpUrl(url)).toThrow();
  });

  test('validates every redirect destination and rejects a private redirect', async () => {
    const fetch = jest.fn(async () =>
      response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
      }),
    );

    await expect(
      websiteConnector.sync(
        { config: { url: 'https://example.com/' } },
        { fetch: fetch as typeof globalThis.fetch, assertSafeUrl },
      ),
    ).rejects.toThrow('redirect URL must not target a local or private address');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  test('does not forward credentials across origins on redirect', async () => {
    const fetch = jest.fn(async () =>
      response('', { status: 307, headers: { location: 'https://other.example/path' } }),
    );

    await expect(
      safeFetch(
        { fetch: fetch as typeof globalThis.fetch, assertSafeUrl },
        'https://api.example/path',
        { headers: { Authorization: 'Bearer secret' } },
      ),
    ).rejects.toThrow('Authenticated connector requests must not redirect to another origin');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('preserves binary Drive files instead of decoding them as text', async () => {
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            files: [{ id: 'pdf-1', name: 'manual.pdf', mimeType: 'application/pdf' }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
      );

    const result = await googleDriveConnector.sync(
      { config: { folderId: 'folder' }, credentials: { accessToken: 'token' } },
      { fetch: fetch as typeof globalThis.fetch, assertSafeUrl },
    );

    expect(result.changes[0]).toMatchObject({
      operation: 'upsert',
      item: { binaryContent: bytes, mimeType: 'application/pdf' },
    });
    expect((result.changes[0] as { item: { content?: string } }).item.content).toBeUndefined();
  });

  test('uses a stable parameterized PostgreSQL cursor and quotes identifiers', async () => {
    const executeReadOnlyQuery = jest.fn(async () => [
      {
        id: 42,
        title: 'Answer',
        body: 'Text',
        updated_at: '2026-09-22T12:00:00Z',
      },
    ]);
    const result = await postgresqlConnector.sync(
      {
        config: {
          schema: 'docs',
          relation: 'articles',
          idColumn: 'id',
          titleColumn: 'title',
          contentColumns: ['body'],
          updatedColumn: 'updated_at',
        },
        credentials: { connectionString: 'postgresql://readonly@example/db' },
        cursor: JSON.stringify({ id: '41', updated: '2026-09-22T12:00:00Z' }),
      },
      {
        fetch: jest.fn() as typeof globalThis.fetch,
        assertSafeUrl,
        executeReadOnlyQuery,
      },
    );

    const [, sql, values] = (
      executeReadOnlyQuery.mock.calls as unknown as [string, string, unknown[]][]
    )[0];
    expect(sql).toContain('FROM "docs"."articles"');
    expect(sql).toContain('"updated_at" = $1 AND "id" > $2');
    expect(values).toEqual(['2026-09-22T12:00:00Z', '41']);
    expect(JSON.parse(result.cursor as string)).toEqual({
      id: '42',
      updated: '2026-09-22T12:00:00Z',
    });
  });

  test('rejects PostgreSQL identifier injection before executing a query', async () => {
    const executeReadOnlyQuery = jest.fn(async () => []);
    await expect(
      postgresqlConnector.sync(
        {
          config: {
            relation: 'articles; DROP TABLE users',
            idColumn: 'id',
            titleColumn: 'title',
            contentColumns: ['body'],
          },
          credentials: { connectionString: 'postgresql://readonly@example/db' },
        },
        {
          fetch: jest.fn() as typeof globalThis.fetch,
          assertSafeUrl,
          executeReadOnlyQuery,
        },
      ),
    ).rejects.toThrow('relation must be a PostgreSQL identifier');
    expect(executeReadOnlyQuery).not.toHaveBeenCalled();
  });
});
