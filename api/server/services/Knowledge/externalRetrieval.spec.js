jest.mock('~/models', () => ({ getKnowledgeSourcesForRetrieval: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({ findAccessibleResources: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { logger } = require('@librechat/data-schemas');
const { createKnowledgeExternalRetrievalService } = require('./externalRetrieval');

const source = (id, overrides = {}) => ({
  _id: id,
  knowledgeBaseId: 'kb-1',
  type: 'external_index',
  config: { url: 'https://search.example/query' },
  credentials: { accessToken: 'top-secret' },
  tenantId: 'tenant-1',
  ...overrides,
});

const registry = (query) => ({
  get: () => ({
    manifest: { capabilities: ['external_retrieval'] },
    query,
  }),
});

describe('external knowledge retrieval', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rechecks every requested knowledge base and fails closed', async () => {
    const database = { getKnowledgeSourcesForRetrieval: jest.fn() };
    const service = createKnowledgeExternalRetrievalService({
      db: database,
      authorize: jest.fn(async () => ['kb-1']),
    });

    await expect(
      service.queryExternalKnowledge({
        knowledgeBaseIds: ['kb-1', 'kb-2'],
        userId: 'user-1',
        query: 'policy',
      }),
    ).rejects.toThrow('unavailable');
    expect(database.getKnowledgeSourcesForRetrieval).not.toHaveBeenCalled();
  });

  it('isolates source failures, redacts secrets, and ranks successful results', async () => {
    const query = jest.fn(async (request) => {
      if (request.config.fail) throw new Error(`bad token ${request.credentials.accessToken}`);
      return [
        {
          externalId: 'doc-1',
          title: 'External policy',
          content: 'Retention is 30 days.',
          metadata: { score: 0.9 },
        },
      ];
    });
    const service = createKnowledgeExternalRetrievalService({
      db: {
        getKnowledgeSourcesForRetrieval: jest.fn(async () => [
          source('failed', { config: { fail: true } }),
          source('ready'),
        ]),
      },
      authorize: jest.fn(async () => ['kb-1']),
      connectorRegistry: registry(query),
      assertSafeUrl: jest.fn(),
    });

    const results = await service.queryExternalKnowledge({
      knowledgeBaseIds: ['kb-1'],
      userId: 'user-1',
      tenantId: 'tenant-1',
      query: 'retention',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual([
      expect.objectContaining({
        page_content: 'Retention is 30 days.',
        metadata: expect.objectContaining({ file_id: 'external:ready:doc-1', external: true }),
      }),
      expect.closeTo(0.1),
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('top-secret');
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('[REDACTED]');
  });

  it('times out one source without preventing other sources from returning', async () => {
    const query = jest.fn((request) => {
      if (!request.config.slow) {
        return Promise.resolve([{ externalId: 'fast', title: 'Fast', content: 'Result' }]);
      }
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('timed out')));
      });
    });
    const service = createKnowledgeExternalRetrievalService({
      db: {
        getKnowledgeSourcesForRetrieval: jest.fn(async () => [
          source('slow', { config: { slow: true } }),
          source('fast'),
        ]),
      },
      authorize: jest.fn(async () => ['kb-1']),
      connectorRegistry: registry(query),
      timeoutMs: 5,
      assertSafeUrl: jest.fn(),
    });

    await expect(
      service.queryExternalKnowledge({
        knowledgeBaseIds: ['kb-1'],
        userId: 'user-1',
        query: 'anything',
      }),
    ).resolves.toEqual([[expect.objectContaining({ page_content: 'Result' }), expect.any(Number)]]);
  });
});
