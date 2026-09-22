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
  type: 'text' | 'url' | 'password' | 'number' | 'boolean' | 'string_array';
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
  setup?: 'manual_credentials';
  capabilities: KnowledgeConnectorCapability[];
  fields: KnowledgeConnectorField[];
}

export interface KnowledgeSourceItem {
  externalId: string;
  title: string;
  /** UTF-8 text ready for chunking. Exactly one content representation is expected. */
  content?: string;
  /** Original bytes for formats such as PDF and Office documents. */
  binaryContent?: Uint8Array;
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
  /** True for a subsequent page in the same sync run. */
  continuation?: boolean;
  signal?: AbortSignal;
}

export interface KnowledgeSyncResult {
  changes: KnowledgeSourceChange[];
  cursor?: string;
  /** False when another connector page must be consumed before this sync is complete. */
  complete?: boolean;
  /** True when the completed run enumerates the source's entire current document set. */
  snapshot?: boolean;
}

export interface KnowledgeQueryRequest {
  query: string;
  config: Record<string, unknown>;
  credentials?: Record<string, string>;
  limit?: number;
  signal?: AbortSignal;
}

export interface KnowledgeConnectorContext {
  /**
   * Fetch implementation supplied by the host. Redirects are handled by the
   * connector helpers, so this function must honor `redirect: 'manual'`.
   */
  fetch: typeof fetch;
  /**
   * Resolve and reject loopback, link-local, private, and otherwise disallowed
   * destinations immediately before each request. This is mandatory because a
   * hostname can pass syntax checks and later resolve to a private address.
   */
  assertSafeUrl: (url: URL, signal?: AbortSignal) => Promise<void>;
  /**
   * The host implementation must enforce a read-only transaction, statement
   * timeout, row/byte limits, and its deployment's TLS policy.
   */
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
