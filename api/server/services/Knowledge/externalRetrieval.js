const { createDefaultKnowledgeConnectorRegistry, validateEndpointURL } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { PermissionBits, ResourceType } = require('librechat-data-provider');
const db = require('~/models');
const { findAccessibleResources } = require('~/server/services/PermissionService');

const MAX_EXTERNAL_SOURCES = 20;
const MAX_EXTERNAL_RESULTS = 10;
const EXTERNAL_QUERY_CONCURRENCY = 3;
const EXTERNAL_QUERY_TIMEOUT_MS = 8_000;

const asString = (value) => value?.toString?.() ?? String(value);
const scopeValue = (value) => (value == null ? null : String(value));

function redactError(error, credentials) {
  let message = error instanceof Error ? error.message : 'External knowledge query failed';
  for (const secret of Object.values(credentials ?? {})) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, 500);
}

function resultDistance(item, index) {
  const distance = item.metadata?.distance;
  if (typeof distance === 'number' && Number.isFinite(distance) && distance >= 0) return distance;
  const score = item.metadata?.score;
  if (typeof score === 'number' && Number.isFinite(score)) {
    return 1 - Math.min(Math.max(score, 0), 1);
  }
  return Math.min(0.5 + index * 0.01, 0.99);
}

function createKnowledgeExternalRetrievalService(overrides = {}) {
  const database = overrides.db ?? db;
  const registry = overrides.connectorRegistry ?? createDefaultKnowledgeConnectorRegistry();
  const authorize =
    overrides.authorize ??
    (({ userId, role }) =>
      findAccessibleResources({
        userId,
        role,
        resourceType: ResourceType.KNOWLEDGE_BASE,
        requiredPermissions: PermissionBits.VIEW,
      }));
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const assertSafeUrl =
    overrides.assertSafeUrl ??
    ((url) => validateEndpointURL(url.toString(), 'external knowledge index'));
  const timeoutMs = overrides.timeoutMs ?? EXTERNAL_QUERY_TIMEOUT_MS;

  async function queryExternalKnowledge({
    knowledgeBaseIds,
    userId,
    role,
    tenantId,
    query,
    limit,
  }) {
    const requested = [...new Set((knowledgeBaseIds ?? []).map(String).filter(Boolean))];
    if (!userId || requested.length === 0) return [];
    const accessible = new Set((await authorize({ userId, role })).map(String));
    const denied = requested.filter((id) => !accessible.has(id));
    if (denied.length > 0) throw new Error('One or more knowledge bases are unavailable');

    const sources = (await database.getKnowledgeSourcesForRetrieval(requested))
      .filter(
        (source) =>
          tenantId == null ||
          source.tenantId == null ||
          scopeValue(source.tenantId) === scopeValue(tenantId),
      )
      .slice(0, MAX_EXTERNAL_SOURCES);
    const perSourceLimit = Math.min(
      Math.max(limit ?? MAX_EXTERNAL_RESULTS, 1),
      MAX_EXTERNAL_RESULTS,
    );
    const results = [];
    let nextSource = 0;

    const worker = async () => {
      while (nextSource < sources.length) {
        const source = sources[nextSource++];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const connector = registry.get(source.type);
          if (!connector.query || !connector.manifest.capabilities.includes('external_retrieval')) {
            continue;
          }
          const items = await connector.query(
            {
              query,
              limit: perSourceLimit,
              config: source.config ?? {},
              credentials: source.credentials,
              signal: controller.signal,
            },
            { fetch: fetchImpl, assertSafeUrl },
          );
          items.slice(0, perSourceLimit).forEach((item, index) => {
            const sourceId = asString(source._id);
            const externalId = item.externalId.slice(0, 512);
            results.push([
              {
                page_content: item.content ?? '',
                metadata: {
                  ...(item.metadata ?? {}),
                  file_id: `external:${sourceId}:${externalId}`,
                  source: item.title,
                  canonical_url: item.canonicalUrl,
                  knowledge_base_id: asString(source.knowledgeBaseId),
                  knowledge_source_id: sourceId,
                  external: true,
                },
              },
              resultDistance(item, index),
            ]);
          });
        } catch (error) {
          logger.warn('[knowledge-external] Source query failed', {
            sourceId: asString(source._id),
            error: redactError(error, source.credentials),
          });
        } finally {
          clearTimeout(timeout);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(EXTERNAL_QUERY_CONCURRENCY, sources.length) }, worker),
    );
    return results.sort((left, right) => left[1] - right[1]).slice(0, perSourceLimit);
  }

  return { queryExternalKnowledge };
}

const externalRetrievalService = createKnowledgeExternalRetrievalService();

module.exports = {
  MAX_EXTERNAL_RESULTS,
  EXTERNAL_QUERY_TIMEOUT_MS,
  createKnowledgeExternalRetrievalService,
  queryExternalKnowledge: externalRetrievalService.queryExternalKnowledge,
};
