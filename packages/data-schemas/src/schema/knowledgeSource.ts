import { Schema } from 'mongoose';
import type { IKnowledgeSourceDocument } from '~/types';

const knowledgeSourceSchema: Schema<IKnowledgeSourceDocument> = new Schema(
  {
    knowledgeBaseId: {
      type: Schema.Types.ObjectId,
      ref: 'KnowledgeBase',
      required: true,
      index: true,
    },
    connectionId: { type: Schema.Types.ObjectId, ref: 'KnowledgeConnection' },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 128 },
    type: { type: String, required: true, maxlength: 64, index: true },
    accessMode: {
      type: String,
      enum: ['shared_snapshot'],
      default: 'shared_snapshot',
      required: true,
    },
    config: { type: Schema.Types.Mixed, default: {} },
    syncStatus: { type: String, enum: ['idle', 'syncing', 'ready', 'failed'], default: 'idle' },
    syncError: { type: String, maxlength: 4000, default: null },
    lastSyncedAt: { type: Date, default: null },
    cursor: { type: String, maxlength: 8192 },
    tenantId: { type: String, index: true },
  },
  { timestamps: true },
);
knowledgeSourceSchema.index({ knowledgeBaseId: 1, createdAt: -1 });
export default knowledgeSourceSchema;
