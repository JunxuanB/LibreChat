import { Schema } from 'mongoose';
import type { IKnowledgeDocumentDocument } from '~/types';

const knowledgeDocumentSchema: Schema<IKnowledgeDocumentDocument> =
  new Schema<IKnowledgeDocumentDocument>(
    {
      knowledgeBaseId: {
        type: Schema.Types.ObjectId,
        ref: 'KnowledgeBase',
        required: true,
        index: true,
      },
      file_id: { type: String, index: true },
      name: { type: String, required: true, trim: true, maxlength: 255 },
      mime_type: { type: String, maxlength: 255 },
      bytes: { type: Number, min: 0 },
      source_type: {
        type: String,
        enum: [
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
        ],
        required: true,
        default: 'upload',
        index: true,
      },
      source_id: { type: String, maxlength: 512 },
      knowledgeSourceId: { type: Schema.Types.ObjectId, ref: 'KnowledgeSource', index: true },
      canonical_url: { type: String, maxlength: 2048 },
      status: {
        type: String,
        enum: ['queued', 'processing', 'ready', 'failed'],
        default: 'queued',
        required: true,
        index: true,
      },
      error: { type: String, maxlength: 4000, default: null },
      revision: { type: String, maxlength: 512 },
      metadata: { type: Schema.Types.Mixed },
      tenantId: { type: String, index: true },
    },
    { timestamps: true },
  );

knowledgeDocumentSchema.index({ knowledgeBaseId: 1, createdAt: -1, _id: -1 });
knowledgeDocumentSchema.index({ knowledgeBaseId: 1, source_type: 1, source_id: 1 });
knowledgeDocumentSchema.index(
  { knowledgeBaseId: 1, knowledgeSourceId: 1, source_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      knowledgeSourceId: { $exists: true },
      source_id: { $type: 'string' },
    },
  },
);

export default knowledgeDocumentSchema;
