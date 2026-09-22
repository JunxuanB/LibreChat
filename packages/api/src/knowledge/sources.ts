import { logger } from '@librechat/data-schemas';
import { createKnowledgeSourceSchema, updateKnowledgeSourceSchema } from 'librechat-data-provider';
import type {
  KnowledgeConnectorType,
  TKnowledgeConnector,
  TKnowledgeSource,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type SourceRecord = Omit<
  TKnowledgeSource,
  '_id' | 'knowledgeBaseId' | 'createdAt' | 'updatedAt'
> & {
  _id: { toString(): string };
  knowledgeBaseId: { toString(): string };
  createdAt?: Date;
  updatedAt?: Date;
  lastSyncedAt?: Date | null;
  connection?: unknown;
  cursor?: string;
};

export interface KnowledgeConnectorCatalog {
  list(): TKnowledgeConnector[] | Promise<TKnowledgeConnector[]>;
  get(type: KnowledgeConnectorType): { manifest: TKnowledgeConnector };
}
export interface KnowledgeSourceHandlerDeps {
  connectorRegistry?: KnowledgeConnectorCatalog;
  listKnowledgeSources(id: string): Promise<SourceRecord[]>;
  createKnowledgeSource(input: {
    knowledgeBaseId: string;
    owner: unknown;
    tenantId?: string;
    source: Record<string, unknown>;
  }): Promise<SourceRecord | null>;
  updateKnowledgeSource(
    baseId: string,
    sourceId: string,
    input: Record<string, unknown>,
  ): Promise<SourceRecord | null>;
  deleteKnowledgeSource(baseId: string, sourceId: string): Promise<{ deleted: boolean }>;
  syncKnowledgeSource(baseId: string, sourceId: string): Promise<SourceRecord | null>;
}
export interface KnowledgeSourceHandlers {
  connectors(req: ServerRequest, res: Response): Promise<Response>;
  list(req: ServerRequest, res: Response): Promise<Response>;
  create(req: ServerRequest, res: Response): Promise<Response>;
  patch(req: ServerRequest, res: Response): Promise<Response>;
  remove(req: ServerRequest, res: Response): Promise<Response>;
  sync(req: ServerRequest, res: Response): Promise<Response>;
}

const serialize = (source: SourceRecord): TKnowledgeSource => {
  const { connection: _connection, cursor: _cursor, ...safe } = source;
  return {
    ...safe,
    _id: source._id.toString(),
    knowledgeBaseId: source.knowledgeBaseId.toString(),
    createdAt: (source.createdAt ?? new Date()).toISOString(),
    updatedAt: (source.updatedAt ?? new Date()).toISOString(),
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
  };
};

type SourceInput = {
  type: string;
  config: Record<string, unknown>;
  credentials?: Record<string, string>;
};

type ValidationIssue = { path: string[]; message: string };

const hasValue = (value: unknown): boolean =>
  value != null &&
  (!(typeof value === 'string') || value.trim().length > 0) &&
  (!Array.isArray(value) || value.length > 0);

const matchesFieldType = (type: string, value: unknown): boolean => {
  switch (type) {
    case 'text':
    case 'password':
      return typeof value === 'string';
    case 'url':
      if (typeof value !== 'string') return false;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string_array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
    default:
      return false;
  }
};

const validateSource = (
  input: SourceInput,
  registry: KnowledgeConnectorCatalog,
): ValidationIssue[] => {
  if (input.type === 'upload') {
    return [{ path: ['type'], message: 'Upload sources must be added through the documents API' }];
  }

  let connector: { manifest: TKnowledgeConnector };
  try {
    connector = registry.get(input.type as KnowledgeConnectorType);
  } catch {
    return [{ path: ['type'], message: `Unsupported knowledge source type: ${input.type}` }];
  }

  const issues: ValidationIssue[] = [];
  const fields = new Map(connector.manifest.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input.config)) {
    const field = fields.get(key);
    if (!field) issues.push({ path: ['config', key], message: 'Unknown connector field' });
    else if (field.secret)
      issues.push({ path: ['config', key], message: 'Secret fields must be supplied as credentials' });
  }
  for (const key of Object.keys(input.credentials ?? {})) {
    const field = fields.get(key);
    if (!field) issues.push({ path: ['credentials', key], message: 'Unknown connector field' });
    else if (!field.secret)
      issues.push({ path: ['credentials', key], message: 'Non-secret fields must be supplied in config' });
  }
  for (const field of connector.manifest.fields) {
    const container = field.secret ? input.credentials ?? {} : input.config;
    const value = container[field.key];
    const path = [field.secret ? 'credentials' : 'config', field.key];
    if (field.required && !hasValue(value)) {
      issues.push({ path, message: `${field.label} is required` });
    } else if (value != null && !matchesFieldType(field.type, value)) {
      issues.push({ path, message: `${field.label} must be a valid ${field.type}` });
    }
  }
  return issues;
};

export function createKnowledgeSourceHandlers(
  deps: KnowledgeSourceHandlerDeps,
): KnowledgeSourceHandlers {
  return {
    async connectors(_req, res) {
      return res
        .status(200)
        .json({ connectors: deps.connectorRegistry ? await deps.connectorRegistry.list() : [] });
    },
    async list(req, res) {
      const sources = await deps.listKnowledgeSources((req.params as { id: string }).id);
      return res.status(200).json({ sources: sources.map(serialize) });
    },
    async create(req, res) {
      const parsed = createKnowledgeSourceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      if (!deps.connectorRegistry) {
        return res.status(503).json({ error: 'Knowledge connector catalog unavailable' });
      }
      const issues = validateSource(parsed.data, deps.connectorRegistry);
      if (issues.length > 0) return res.status(400).json({ error: 'Validation failed', issues });
      try {
        const source = await deps.createKnowledgeSource({
          knowledgeBaseId: (req.params as { id: string }).id,
          owner: req.user?._id ?? req.user?.id,
          tenantId: req.user?.tenantId,
          source: parsed.data,
        });
        return source
          ? res.status(201).json(serialize(source))
          : res.status(404).json({ error: 'Knowledge base not found' });
      } catch (error) {
        logger.error('[knowledge-sources] Error creating source', error);
        return res.status(500).json({ error: 'Error creating knowledge source' });
      }
    },
    async patch(req, res) {
      const parsed = updateKnowledgeSourceSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
      const { id, sourceId } = req.params as { id: string; sourceId: string };
      const source = await deps.updateKnowledgeSource(id, sourceId, parsed.data);
      return source
        ? res.status(200).json(serialize(source))
        : res.status(404).json({ error: 'Knowledge source not found' });
    },
    async remove(req, res) {
      const { id, sourceId } = req.params as { id: string; sourceId: string };
      const result = await deps.deleteKnowledgeSource(id, sourceId);
      return result.deleted
        ? res.status(200).json(result)
        : res.status(404).json({ error: 'Knowledge source not found' });
    },
    async sync(req, res) {
      const { id, sourceId } = req.params as { id: string; sourceId: string };
      try {
        const source = await deps.syncKnowledgeSource(id, sourceId);
        return source
          ? res.status(202).json(serialize(source))
          : res.status(404).json({ error: 'Knowledge source not found' });
      } catch {
        logger.error('[knowledge-sources] Error syncing source');
        return res.status(500).json({ error: 'Error syncing knowledge source' });
      }
    },
  };
}
