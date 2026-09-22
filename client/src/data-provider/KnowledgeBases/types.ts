import type {
  TKnowledgeBase,
  TKnowledgeDocument,
  TKnowledgeBaseListResponse,
  TCreateKnowledgeBase,
} from 'librechat-data-provider';

export type KnowledgeDocument = TKnowledgeDocument;
export type KnowledgeBase = TKnowledgeBase & { documents?: TKnowledgeDocument[] };

export interface KnowledgeConnector {
  type: string;
  name: string;
  description?: string;
  category?: string;
  setup?: 'manual_credentials';
  capabilities?: string[];
  fields?: KnowledgeConnectorField[];
}

export interface KnowledgeConnectorField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'number' | 'select' | 'boolean' | 'textarea';
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface KnowledgeSource {
  _id: string;
  knowledgeBaseId: string;
  type: string;
  accessMode?: 'shared_snapshot';
  config?: Record<string, unknown>;
  name: string;
  syncStatus?: 'idle' | 'queued' | 'syncing' | 'ready' | 'failed';
  lastSyncedAt?: string | null;
  syncError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface KnowledgeSourceInput {
  type: string;
  name: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
}

export type KnowledgeSourceUpdateInput = Omit<KnowledgeSourceInput, 'type'>;

export type KnowledgeBaseListResponse = TKnowledgeBaseListResponse;

export interface KnowledgeConnectorListResponse {
  connectors: KnowledgeConnector[];
}

export interface KnowledgeSourceListResponse {
  sources: KnowledgeSource[];
}

export type KnowledgeBaseInput = TCreateKnowledgeBase;
