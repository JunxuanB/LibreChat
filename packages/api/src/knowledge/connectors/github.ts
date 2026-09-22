import { bearerHeaders, expectOk, optionalString, requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

interface GitTree {
  sha: string;
  tree: Array<{ path: string; type: string; sha: string; size?: number }>;
}

const DEFAULT_EXTENSIONS = [
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.java',
  '.rb',
  '.rs',
  '.sql',
  '.yaml',
  '.yml',
  '.json',
];

export const githubConnector: KnowledgeConnector = {
  manifest: {
    type: 'github',
    name: 'GitHub',
    description: 'Index text and source files from a repository.',
    category: 'app',
    capabilities: ['incremental_sync', 'deletions'],
    fields: [
      { key: 'owner', label: 'Owner', type: 'text', required: true },
      { key: 'repository', label: 'Repository', type: 'text', required: true },
      { key: 'ref', label: 'Branch or tag', type: 'text', placeholder: 'HEAD' },
      { key: 'path', label: 'Path prefix', type: 'text' },
      { key: 'accessToken', label: 'Access token', type: 'password', secret: true },
    ],
  },

  async validate(request, context) {
    const owner = requiredString(request.config, 'owner');
    const repository = requiredString(request.config, 'repository');
    await expectOk(
      await context.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
        headers: { ...bearerHeaders(request), Accept: 'application/vnd.github+json' },
        signal: request.signal,
      }),
      'GitHub',
    );
  },

  async sync(request, context) {
    const owner = requiredString(request.config, 'owner');
    const repository = requiredString(request.config, 'repository');
    const ref = optionalString(request.config, 'ref') ?? 'HEAD';
    const prefix = optionalString(request.config, 'path')?.replace(/^\/+|\/+$/g, '');
    const headers = { ...bearerHeaders(request), Accept: 'application/vnd.github+json' };
    const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const tree = (await (
      await expectOk(
        await context.fetch(treeUrl, { headers, signal: request.signal }),
        'GitHub',
      )
    ).json()) as GitTree;
    const maxFiles = Math.max(1, Math.min(1000, Number(request.config.maxFiles ?? 250)));
    const candidates = tree.tree
      .filter(({ path, type, size }) => {
        const normalized = path.toLowerCase();
        return (
          type === 'blob' &&
          (prefix == null || path === prefix || path.startsWith(`${prefix}/`)) &&
          DEFAULT_EXTENSIONS.some((extension) => normalized.endsWith(extension)) &&
          (size == null || size <= 2_000_000)
        );
      })
      .slice(0, maxFiles);
    const changes: KnowledgeSourceChange[] = [];
    for (const entry of candidates) {
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${entry.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const content = await (
        await expectOk(
          await context.fetch(rawUrl, { headers, signal: request.signal }),
          'GitHub',
        )
      ).text();
      changes.push({
        operation: 'upsert',
        item: {
          externalId: entry.path,
          title: entry.path,
          content,
          mimeType: 'text/plain',
          revision: entry.sha,
          canonicalUrl: `https://github.com/${owner}/${repository}/blob/${ref}/${entry.path}`,
          metadata: { owner, repository, ref, path: entry.path },
        },
      });
    }
    return { changes, cursor: tree.sha };
  },
};
