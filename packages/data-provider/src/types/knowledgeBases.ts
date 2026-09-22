import { z } from 'zod';

export const knowledgeDocumentStatusSchema = z.enum(['queued', 'processing', 'ready', 'failed']);

export const knowledgeSourceTypeSchema = z.enum([
  'upload',
  'sharepoint',
  'google_drive',
  'notion',
  'confluence',
  'github',
  'website',
  'postgresql',
  'custom_api',
  'mcp',
  'external_index',
]);

export const createKnowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional().default(''),
});

export const updateKnowledgeBaseSchema = createKnowledgeBaseSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const createKnowledgeDocumentSchema = z.object({
  file_id: z.string().trim().min(1).max(512).optional(),
  name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().max(255).optional(),
  bytes: z.number().int().nonnegative().optional(),
  source_type: knowledgeSourceTypeSchema.default('upload'),
  source_id: z.string().trim().max(512).optional(),
  canonical_url: z.string().url().max(2048).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateKnowledgeDocumentSchema = z.object({
  status: knowledgeDocumentStatusSchema,
  error: z.string().max(4000).nullable().optional(),
  revision: z.string().max(512).optional(),
});

export type KnowledgeDocumentStatus = z.infer<typeof knowledgeDocumentStatusSchema>;
export type KnowledgeSourceType = z.infer<typeof knowledgeSourceTypeSchema>;
export type KnowledgeConnectorType = Exclude<KnowledgeSourceType, 'upload'>;
export type TCreateKnowledgeBase = z.infer<typeof createKnowledgeBaseSchema>;
export type TUpdateKnowledgeBase = z.infer<typeof updateKnowledgeBaseSchema>;
export type TCreateKnowledgeDocument = z.infer<typeof createKnowledgeDocumentSchema>;
export type TUpdateKnowledgeDocument = z.infer<typeof updateKnowledgeDocumentSchema>;

export type TKnowledgeBase = {
  _id: string;
  name: string;
  description: string;
  author: string;
  authorName: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
  tenantId?: string;
};

export type TKnowledgeDocument = {
  _id: string;
  knowledgeBaseId: string;
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
  createdAt: string;
  updatedAt: string;
};

export type TKnowledgeBaseListResponse = {
  knowledgeBases: TKnowledgeBase[];
  nextCursor: string | null;
};

export type TKnowledgeDocumentListResponse = {
  documents: TKnowledgeDocument[];
  nextCursor: string | null;
};

export const knowledgeSourceSyncStatusSchema = z.enum(['idle', 'syncing', 'ready', 'failed']);
export const knowledgeSourceAccessModeSchema = z.enum(['shared_snapshot']);
export const createKnowledgeSourceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: knowledgeSourceTypeSchema,
  config: z.record(z.unknown()).optional().default({}),
  credentials: z.record(z.string()).optional(),
  accessMode: knowledgeSourceAccessModeSchema.optional().default('shared_snapshot'),
});
export const updateKnowledgeSourceSchema = createKnowledgeSourceSchema
  .omit({ type: true })
  .partial()
  .extend({
    syncStatus: knowledgeSourceSyncStatusSchema.optional(),
    syncError: z.string().max(4000).nullable().optional(),
    lastSyncedAt: z.string().datetime().nullable().optional(),
  });
export type TCreateKnowledgeSource = z.infer<typeof createKnowledgeSourceSchema>;
export type KnowledgeSourceAccessMode = z.infer<typeof knowledgeSourceAccessModeSchema>;
export type TUpdateKnowledgeSource = z.infer<typeof updateKnowledgeSourceSchema>;
export type TKnowledgeSource = {
  _id: string;
  knowledgeBaseId: string;
  name: string;
  type: KnowledgeSourceType;
  accessMode: KnowledgeSourceAccessMode;
  config: Record<string, unknown>;
  syncStatus: z.infer<typeof knowledgeSourceSyncStatusSchema>;
  syncError?: string | null;
  lastSyncedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TKnowledgeConnector = {
  type: KnowledgeConnectorType;
  name: string;
  description: string;
  category: string;
  setup?: 'manual_credentials';
  capabilities: string[];
  fields: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    secret?: boolean;
    placeholder?: string;
    help?: string;
  }>;
};
