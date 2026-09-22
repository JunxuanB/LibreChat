import { logger } from '@librechat/data-schemas';
import { createKnowledgeSourceSchema, updateKnowledgeSourceSchema } from 'librechat-data-provider';
import type { TKnowledgeConnector, TKnowledgeSource } from 'librechat-data-provider';
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
};

export interface KnowledgeConnectorCatalog {
  list(): TKnowledgeConnector[] | Promise<TKnowledgeConnector[]>;
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
  const { connection: _connection, ...safe } = source;
  return {
    ...safe,
    _id: source._id.toString(),
    knowledgeBaseId: source.knowledgeBaseId.toString(),
    createdAt: (source.createdAt ?? new Date()).toISOString(),
    updatedAt: (source.updatedAt ?? new Date()).toISOString(),
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
  };
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
      const source = await deps.updateKnowledgeSource(id, sourceId, {
        syncStatus: 'syncing',
        syncError: null,
      });
      return source
        ? res.status(202).json(serialize(source))
        : res.status(404).json({ error: 'Knowledge source not found' });
    },
  };
}
