import type {
  TKnowledgeBase,
  TKnowledgeDocument,
  TKnowledgeBaseListResponse,
  TCreateKnowledgeBase,
} from 'librechat-data-provider';

export type KnowledgeDocument = TKnowledgeDocument;
export type KnowledgeBase = TKnowledgeBase & { documents?: TKnowledgeDocument[] };

export interface KnowledgeConnector {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
}

export type KnowledgeBaseListResponse = TKnowledgeBaseListResponse;

export interface KnowledgeConnectorListResponse {
  connectors: KnowledgeConnector[];
}

export type KnowledgeBaseInput = TCreateKnowledgeBase;
