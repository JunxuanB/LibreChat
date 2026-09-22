import type {
  KnowledgeDocumentStatus,
  KnowledgeSourceAccessMode,
  KnowledgeSourceType,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export interface IKnowledgeBase {
  _id?: Types.ObjectId;
  name: string;
  description: string;
  author: Types.ObjectId;
  authorName: string;
  documentCount: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IKnowledgeBaseDocument extends Omit<IKnowledgeBase, '_id'>, Document {}

export interface IKnowledgeDocument {
  _id?: Types.ObjectId;
  knowledgeBaseId: Types.ObjectId;
  file_id?: string;
  name: string;
  mime_type?: string;
  bytes?: number;
  source_type: KnowledgeSourceType;
  source_id?: string;
  canonical_url?: string;
  status: KnowledgeDocumentStatus;
  error?: string | null;
  revision?: string;
  metadata?: Record<string, unknown>;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IKnowledgeDocumentDocument extends Omit<IKnowledgeDocument, '_id'>, Document {}

export interface IKnowledgeConnection {
  _id?: Types.ObjectId;
  name: string;
  provider: KnowledgeSourceType;
  owner: Types.ObjectId;
  encryptedSecrets: string;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export interface IKnowledgeConnectionDocument extends Omit<IKnowledgeConnection, '_id'>, Document {}

export interface IKnowledgeSource {
  _id?: Types.ObjectId;
  knowledgeBaseId: Types.ObjectId;
  connectionId?: Types.ObjectId;
  owner: Types.ObjectId;
  name: string;
  type: KnowledgeSourceType;
  accessMode: KnowledgeSourceAccessMode;
  config: Record<string, unknown>;
  syncStatus: 'idle' | 'syncing' | 'ready' | 'failed';
  syncError?: string | null;
  lastSyncedAt?: Date | null;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export interface IKnowledgeSourceDocument extends Omit<IKnowledgeSource, '_id'>, Document {}
