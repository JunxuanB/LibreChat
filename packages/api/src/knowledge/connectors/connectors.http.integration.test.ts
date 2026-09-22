import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  confluenceConnector,
  customApiConnector,
  externalIndexConnector,
  githubConnector,
  googleDriveConnector,
  notionConnector,
  sharePointConnector,
  websiteConnector,
} from '.';
import type { KnowledgeConnectorContext } from './types';

type CapturedRequest = { url: URL; method: string; authorization?: string; body: string };

const json = (res: ServerResponse, value: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

describe('knowledge HTTP connector contracts', () => {
  let origin: string;
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const target = new URL(String(req.headers['x-mock-target']));
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({
      url: target,
      method: req.method ?? 'GET',
      authorization: req.headers.authorization,
      body,
    });

    if (target.hostname === 'docs.example.test') {
      res.setHeader('content-type', 'text/html');
      res.setHeader('etag', 'website-v1');
      res.end('<html><head><title>Runtime guide</title></head><body>Search me</body></html>');
      return;
    }
    if (target.hostname === 'api.github.com') {
      json(res, {
        sha: 'tree-v1',
        tree: [{ path: 'README.md', type: 'blob', sha: 'blob-v1', size: 12 }],
      });
      return;
    }
    if (target.hostname === 'raw.githubusercontent.com') {
      res.setHeader('content-type', 'text/plain');
      res.end('# GitHub guide');
      return;
    }
    if (target.hostname === 'www.googleapis.com' && target.pathname.endsWith('/files')) {
      json(res, {
        files: [
          {
            id: 'drive-1',
            name: 'Drive guide',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2026-09-22T12:00:00Z',
          },
        ],
      });
      return;
    }
    if (target.hostname === 'www.googleapis.com' && target.pathname.includes('/drive-1/export')) {
      res.setHeader('content-type', 'text/plain');
      res.end('Drive body');
      return;
    }
    if (target.hostname === 'graph.microsoft.com') {
      json(res, {
        value: [
          {
            id: 'sharepoint-1',
            name: 'SharePoint guide.txt',
            eTag: 'sp-v1',
            file: { mimeType: 'text/plain' },
            '@microsoft.graph.downloadUrl': 'https://download.sharepoint.test/guide',
          },
        ],
      });
      return;
    }
    if (target.hostname === 'download.sharepoint.test') {
      res.setHeader('content-type', 'text/plain');
      res.end('SharePoint body');
      return;
    }
    if (target.hostname === 'api.notion.com' && target.pathname.startsWith('/v1/pages/')) {
      json(res, {
        id: 'notion-1',
        url: 'https://notion.so/notion-1',
        last_edited_time: '2026-09-22T12:00:00Z',
        properties: { Name: { title: [{ plain_text: 'Notion guide' }] } },
      });
      return;
    }
    if (target.hostname === 'api.notion.com' && target.pathname.includes('/children')) {
      json(res, {
        results: [
          {
            id: 'block-1',
            type: 'paragraph',
            paragraph: { rich_text: [{ plain_text: 'Notion body' }] },
          },
        ],
        has_more: false,
      });
      return;
    }
    if (target.hostname === 'acme.atlassian.test') {
      json(res, {
        results: [
          {
            id: 'confluence-1',
            title: 'Confluence guide',
            version: { number: 3, createdAt: '2026-09-22T12:00:00Z' },
            body: { storage: { value: '<p>Confluence body</p>' } },
            _links: { webui: '/wiki/spaces/DOC/pages/1' },
          },
        ],
      });
      return;
    }
    if (target.hostname === 'custom.example.test') {
      json(res, {
        items: [{ id: 'custom-1', title: 'Custom guide', content: 'Custom body' }],
        deleted: ['custom-old'],
        cursor: 'custom-next',
      });
      return;
    }
    if (target.hostname === 'search.example.test') {
      json(res, {
        results: [{ id: 'external-1', title: 'External guide', content: 'External body' }],
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => requests.splice(0));

  const context = (): KnowledgeConnectorContext => ({
    assertSafeUrl: jest.fn(async () => undefined),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : input.toString();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('x-mock-target', target);
      return fetch(origin, { ...init, headers });
    }) as typeof fetch,
  });

  test('normalizes Website and GitHub responses through real HTTP I/O', async () => {
    const website = await websiteConnector.sync(
      { config: { url: 'https://docs.example.test/guide' } },
      context(),
    );
    const github = await githubConnector.sync(
      {
        config: { owner: 'librechat', repository: 'docs' },
        credentials: { accessToken: 'github-token' },
      },
      context(),
    );

    expect(website.changes[0]).toMatchObject({
      operation: 'upsert',
      item: { title: 'Runtime guide', content: 'Runtime guide Search me', revision: 'website-v1' },
    });
    expect(github).toMatchObject({
      cursor: 'tree-v1',
      changes: [{ item: { externalId: 'README.md', content: '# GitHub guide' } }],
    });
    expect(
      requests
        .filter(({ url }) => url.hostname.includes('github'))
        .every(({ authorization }) => authorization === 'Bearer github-token'),
    ).toBe(true);
  });

  test('normalizes Drive and SharePoint downloads through real HTTP I/O', async () => {
    const drive = await googleDriveConnector.sync(
      { config: { folderId: 'folder-1' }, credentials: { accessToken: 'drive-token' } },
      context(),
    );
    const sharepoint = await sharePointConnector.sync(
      {
        config: { driveId: 'drive-1', folderId: 'root' },
        credentials: { accessToken: 'sharepoint-token' },
      },
      context(),
    );

    expect(drive.changes[0]).toMatchObject({
      item: { externalId: 'drive-1', title: 'Drive guide.txt', content: 'Drive body' },
    });
    expect(sharepoint.changes[0]).toMatchObject({
      item: { externalId: 'sharepoint-1', content: 'SharePoint body', revision: 'sp-v1' },
    });
    expect(
      requests.find(({ url }) => url.hostname === 'download.sharepoint.test')?.authorization,
    ).toBeUndefined();
  });

  test('normalizes Notion and Confluence page content through real HTTP I/O', async () => {
    const notion = await notionConnector.sync(
      { config: { pageId: 'notion-1' }, credentials: { accessToken: 'notion-token' } },
      context(),
    );
    const confluence = await confluenceConnector.sync(
      {
        config: { baseUrl: 'https://acme.atlassian.test', spaceId: 'DOC' },
        credentials: { accessToken: 'confluence-token' },
      },
      context(),
    );

    expect(notion.changes[0]).toMatchObject({
      item: { title: 'Notion guide', content: 'Notion body' },
    });
    expect(confluence.changes[0]).toMatchObject({
      item: { title: 'Confluence guide', content: 'Confluence body', revision: '3' },
    });
    expect(requests.find(({ url }) => url.hostname === 'api.notion.com')?.authorization).toBe(
      'Bearer notion-token',
    );
  });

  test('sends incremental Custom API and live External Index contracts over HTTP', async () => {
    const custom = await customApiConnector.sync(
      {
        config: { url: 'https://custom.example.test/feed' },
        credentials: { accessToken: 'custom-token' },
        cursor: 'custom-old',
      },
      context(),
    );
    const external = await externalIndexConnector.query?.(
      {
        query: 'retention',
        limit: 3,
        config: { url: 'https://search.example.test/query' },
        credentials: { accessToken: 'external-token' },
      },
      context(),
    );

    expect(custom).toMatchObject({
      cursor: 'custom-next',
      changes: [{ item: { externalId: 'custom-1' } }, { externalId: 'custom-old' }],
    });
    expect(external).toEqual([
      expect.objectContaining({ externalId: 'external-1', content: 'External body' }),
    ]);
    expect(
      requests
        .find(({ url }) => url.hostname === 'custom.example.test')
        ?.url.searchParams.get('cursor'),
    ).toBe('custom-old');
    const search = requests.find(({ url }) => url.hostname === 'search.example.test');
    expect(search).toMatchObject({ method: 'POST', authorization: 'Bearer external-token' });
    expect(JSON.parse(search?.body ?? '{}')).toEqual({ query: 'retention', limit: 3 });
  });
});
