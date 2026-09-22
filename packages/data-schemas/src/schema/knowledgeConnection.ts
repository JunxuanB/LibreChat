import { Schema } from 'mongoose';
import type { IKnowledgeConnectionDocument } from '~/types';

const knowledgeConnectionSchema: Schema<IKnowledgeConnectionDocument> = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 128 },
    provider: { type: String, required: true, maxlength: 64, index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    encryptedSecrets: { type: String, required: true, select: false },
    tenantId: { type: String, index: true },
  },
  { timestamps: true },
);
knowledgeConnectionSchema.index({ owner: 1, provider: 1, name: 1 });
export default knowledgeConnectionSchema;
