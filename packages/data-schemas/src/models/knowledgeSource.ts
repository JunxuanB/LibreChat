import type { Model } from 'mongoose';
import type { IKnowledgeSourceDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import schema from '~/schema/knowledgeSource';
export function createKnowledgeSourceModel(
  mongoose: typeof import('mongoose'),
): Model<IKnowledgeSourceDocument> {
  applyTenantIsolation(schema);
  return (
    mongoose.models.KnowledgeSource ||
    mongoose.model<IKnowledgeSourceDocument>('KnowledgeSource', schema)
  );
}
