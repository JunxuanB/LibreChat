import type { Model } from 'mongoose';
import type { IKnowledgeBaseDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import knowledgeBaseSchema from '~/schema/knowledgeBase';

export function createKnowledgeBaseModel(
  mongoose: typeof import('mongoose'),
): Model<IKnowledgeBaseDocument> {
  applyTenantIsolation(knowledgeBaseSchema);
  return (
    mongoose.models.KnowledgeBase ||
    mongoose.model<IKnowledgeBaseDocument>('KnowledgeBase', knowledgeBaseSchema)
  );
}
