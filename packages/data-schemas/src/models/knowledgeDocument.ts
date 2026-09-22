import type { Model } from 'mongoose';
import type { IKnowledgeDocumentDocument } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import knowledgeDocumentSchema from '~/schema/knowledgeDocument';

export function createKnowledgeDocumentModel(
  mongoose: typeof import('mongoose'),
): Model<IKnowledgeDocumentDocument> {
  applyTenantIsolation(knowledgeDocumentSchema);
  return (
    mongoose.models.KnowledgeDocument ||
    mongoose.model<IKnowledgeDocumentDocument>('KnowledgeDocument', knowledgeDocumentSchema)
  );
}
