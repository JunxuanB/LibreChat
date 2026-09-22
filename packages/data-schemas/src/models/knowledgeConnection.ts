import type { Model } from 'mongoose';
import type { IKnowledgeConnectionDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import schema from '~/schema/knowledgeConnection';
export function createKnowledgeConnectionModel(
  mongoose: typeof import('mongoose'),
): Model<IKnowledgeConnectionDocument> {
  applyTenantIsolation(schema);
  return (
    mongoose.models.KnowledgeConnection ||
    mongoose.model<IKnowledgeConnectionDocument>('KnowledgeConnection', schema)
  );
}
