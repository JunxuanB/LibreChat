import type {
  KnowledgeConnectorContext,
  KnowledgeConnectorType,
  KnowledgeSourceItem,
} from './connectors/types';

export type KnowledgeSyncSource = {
  id: string;
  knowledgeBaseId: string;
  /** Persisted owner used to rebuild connector credentials for unattended syncs. */
  ownerId: string;
  tenantId?: string;
  type: KnowledgeConnectorType;
  config: Record<string, unknown>;
  connectionId?: string;
  cursor?: string;
  syncAttempts?: number;
};

export type KnowledgeSyncState = {
  syncStatus: 'queued' | 'syncing' | 'ready' | 'failed';
  syncError?: string | null;
  cursor?: string;
  lastSyncedAt?: Date;
  nextSyncAt?: Date | null;
  syncAttempts?: number;
};

export type KnowledgeSyncDocumentKey = {
  knowledgeBaseId: string;
  sourceId: string;
  sourceType: KnowledgeConnectorType;
};

export interface KnowledgeSourceSyncDependencies {
  loadSource(knowledgeBaseId: string, sourceId: string): Promise<KnowledgeSyncSource | null>;
  loadCredentials(connectionId: string): Promise<Record<string, string> | null>;
  connectorRegistry: {
    get(type: KnowledgeConnectorType): {
      validate: import('./connectors/types').KnowledgeConnector['validate'];
      sync: import('./connectors/types').KnowledgeConnector['sync'];
    };
  };
  getConnectorContext(source: KnowledgeSyncSource): Promise<KnowledgeConnectorContext>;
  upsertDocument(key: KnowledgeSyncDocumentKey, item: KnowledgeSourceItem): Promise<void>;
  deleteDocument(key: KnowledgeSyncDocumentKey, externalId: string): Promise<void>;
  reconcileDocuments?(
    key: KnowledgeSyncDocumentKey,
    retainedExternalIds: readonly string[],
  ): Promise<number>;
  updateSourceState(sourceId: string, state: KnowledgeSyncState): Promise<void | boolean>;
  now?: () => Date;
}

export type KnowledgeSourceSyncResult = {
  sourceId: string;
  upserted: number;
  deleted: number;
  cursor?: string;
};

function safeErrorMessage(error: unknown, credentials?: Record<string, string>): string {
  let message = error instanceof Error ? error.message : 'Knowledge source sync failed';
  for (const secret of Object.values(credentials ?? {})) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, 4000);
}

/**
 * Coordinates connector syncs without knowing how documents or jobs are stored.
 * A runner instance is intentionally single-flight per source so HTTP handlers and
 * schedulers can safely share it.
 */
export class KnowledgeSourceSyncRunner {
  private readonly inFlight = new Map<string, Promise<KnowledgeSourceSyncResult>>();

  constructor(private readonly deps: KnowledgeSourceSyncDependencies) {}

  run(knowledgeBaseId: string, sourceId: string): Promise<KnowledgeSourceSyncResult> {
    const key = `${knowledgeBaseId}:${sourceId}`;
    const active = this.inFlight.get(key);
    if (active) return active;

    const sync = this.execute(knowledgeBaseId, sourceId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, sync);
    return sync;
  }

  private async execute(
    knowledgeBaseId: string,
    sourceId: string,
  ): Promise<KnowledgeSourceSyncResult> {
    const source = await this.deps.loadSource(knowledgeBaseId, sourceId);
    if (!source) throw new Error('Knowledge source not found');

    await this.deps.updateSourceState(source.id, {
      syncStatus: 'syncing',
      syncError: null,
      syncAttempts: (source.syncAttempts ?? 0) + 1,
      nextSyncAt: null,
    });
    let credentials: Record<string, string> | undefined;
    try {
      const connector = this.deps.connectorRegistry.get(source.type);
      const connectorContext = await this.deps.getConnectorContext(source);
      credentials = source.connectionId
        ? ((await this.deps.loadCredentials(source.connectionId)) ?? undefined)
        : undefined;
      const request = { config: source.config, credentials, cursor: source.cursor };

      await connector.validate(request, connectorContext);
      const documentKey: KnowledgeSyncDocumentKey = {
        knowledgeBaseId: source.knowledgeBaseId,
        sourceId: source.id,
        sourceType: source.type,
      };
      let upserted = 0;
      let deleted = 0;
      let cursor = source.cursor;
      let snapshot = false;
      const retainedExternalIds = new Set<string>();
      for (let page = 0; page < 1000; page += 1) {
        const result = await connector.sync(
          { ...request, cursor, continuation: page > 0 },
          connectorContext,
        );
        snapshot ||= result.snapshot === true;
        for (const change of result.changes) {
          if (change.operation === 'upsert') {
            await this.deps.upsertDocument(documentKey, change.item);
            retainedExternalIds.add(change.item.externalId);
            upserted += 1;
          } else {
            await this.deps.deleteDocument(documentKey, change.externalId);
            deleted += 1;
          }
        }
        const previousCursor = cursor;
        cursor = result.cursor;
        if (result.complete !== false) break;
        if (!cursor || cursor === previousCursor) {
          throw new Error('Knowledge connector pagination did not advance its cursor');
        }
        if (page === 999) {
          throw new Error('Knowledge connector pagination exceeded its safety limit');
        }
      }

      if (snapshot && this.deps.reconcileDocuments) {
        deleted += await this.deps.reconcileDocuments(
          documentKey,
          [...retainedExternalIds],
        );
      }

      await this.deps.updateSourceState(source.id, {
        syncStatus: 'ready',
        syncError: null,
        cursor,
        lastSyncedAt: (this.deps.now ?? (() => new Date()))(),
        syncAttempts: 0,
        nextSyncAt: null,
      });
      return { sourceId: source.id, upserted, deleted, cursor };
    } catch (error) {
      const message = safeErrorMessage(error, credentials);
      await this.deps.updateSourceState(source.id, {
        syncStatus: 'failed',
        syncError: message,
      });
      throw new Error(message);
    }
  }
}
