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
    syncStatus: {
      type: String,
      enum: ['idle', 'queued', 'syncing', 'ready', 'failed'],
      default: 'idle',
      index: true,
    },
    syncError: { type: String, maxlength: 4000, default: null },
    lastSyncedAt: { type: Date, default: null },
    syncRequestedAt: { type: Date, default: null },
    nextSyncAt: { type: Date, default: null, index: true },
    syncAttempts: { type: Number, default: 0, min: 0 },
    cursor: { type: String, maxlength: 8192 },
    syncLease: {
      type: new Schema(
        {
          token: { type: String, required: true },
          expiresAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      select: false,
    },
    tenantId: { type: String, index: true },
  },
  { timestamps: true },
);
knowledgeSourceSchema.index({ knowledgeBaseId: 1, createdAt: -1 });
knowledgeSourceSchema.index({ syncStatus: 1, nextSyncAt: 1, syncRequestedAt: 1 });
export default knowledgeSourceSchema;
