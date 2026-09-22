export type KnowledgeConnectorType =
  | 'website'
  | 'github'
  | 'google_drive'
  | 'sharepoint'
  | 'notion'
  | 'confluence'
  | 'postgresql'
  | 'custom_api'
  | 'mcp'
  | 'external_index';

export type KnowledgeConnectorCapability =
  | 'incremental_sync'
  | 'deletions'
  | 'permissions'
  | 'live_query'
  | 'external_retrieval';

export interface KnowledgeConnectorField {
  key: string;
  label: string;
  type: 'text' | 'url' | 'password' | 'number' | 'boolean';
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export interface KnowledgeConnectorManifest {
  type: KnowledgeConnectorType;
  name: string;
  description: string;
  category: 'web' | 'app' | 'database' | 'advanced';
  capabilities: KnowledgeConnectorCapability[];
  fields: KnowledgeConnectorField[];
}

export interface KnowledgeSourceItem {
  externalId: string;
  title: string;
  content: string;
  mimeType?: string;
  canonicalUrl?: string;
  revision?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export type KnowledgeSourceChange =
  | { operation: 'upsert'; item: KnowledgeSourceItem }
  | { operation: 'delete'; externalId: string };

export interface KnowledgeSyncRequest {
  config: Record<string, unknown>;
  credentials?: Record<string, string>;
  cursor?: string;
  signal?: AbortSignal;
}

export interface KnowledgeSyncResult {
  changes: KnowledgeSourceChange[];
  cursor?: string;
}

export interface KnowledgeQueryRequest {
  query: string;
  config: Record<string, unknown>;
  credentials?: Record<string, string>;
  limit?: number;
  signal?: AbortSignal;
}

export interface KnowledgeConnectorContext {
  fetch: typeof fetch;
  executeReadOnlyQuery?: (
    connectionString: string,
    query: string,
    values: unknown[],
    signal?: AbortSignal,
  ) => Promise<Array<Record<string, unknown>>>;
  callMcp?: (
    serverName: string,
    method: 'resources/list' | 'resources/read',
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface KnowledgeConnector {
  manifest: KnowledgeConnectorManifest;
  validate(request: KnowledgeSyncRequest, context: KnowledgeConnectorContext): Promise<void>;
  sync(
    request: KnowledgeSyncRequest,
    context: KnowledgeConnectorContext,
  ): Promise<KnowledgeSyncResult>;
  query?(
    request: KnowledgeQueryRequest,
    context: KnowledgeConnectorContext,
  ): Promise<KnowledgeSourceItem[]>;
}
