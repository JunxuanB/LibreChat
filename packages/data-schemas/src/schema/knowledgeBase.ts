import { Schema } from 'mongoose';
import type { IKnowledgeBaseDocument } from '~/types';

const knowledgeBaseSchema: Schema<IKnowledgeBaseDocument> = new Schema<IKnowledgeBaseDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100, index: true },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorName: { type: String, required: true },
    documentCount: { type: Number, default: 0, min: 0 },
    tenantId: { type: String, index: true },
  },
  { timestamps: true },
);

knowledgeBaseSchema.index({ updatedAt: -1, _id: -1 });
knowledgeBaseSchema.index({ author: 1, name: 1 });

export default knowledgeBaseSchema;
