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
  'custom',
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
