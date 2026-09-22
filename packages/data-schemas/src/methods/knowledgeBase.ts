import type {
  TCreateKnowledgeBase,
  TCreateKnowledgeDocument,
  TUpdateKnowledgeBase,
  TUpdateKnowledgeDocument,
} from 'librechat-data-provider';
import type { FilterQuery, Model, Types } from 'mongoose';
import type {
  IKnowledgeBase,
  IKnowledgeBaseDocument,
  IKnowledgeDocument,
  IKnowledgeDocumentDocument,
} from '~/types';
import { isValidObjectIdString } from '~/utils/objectId';
import { escapeRegExp } from '~/utils/string';

export type CreateKnowledgeBaseInput = TCreateKnowledgeBase & {
  author: Types.ObjectId;
  authorName: string;
  tenantId?: string;
};

export type ListKnowledgeBasesParams = {
  accessibleIds: Array<string | Types.ObjectId>;
  search?: string;
  cursor?: string | null;
  limit?: number;
};

export type ListKnowledgeBasesResult = {
  knowledgeBases: Array<IKnowledgeBase & { _id: Types.ObjectId }>;
  nextCursor: string | null;
};

export type ListKnowledgeDocumentsParams = {
  knowledgeBaseId: string | Types.ObjectId;
  cursor?: string | null;
  limit?: number;
};

export type ListKnowledgeDocumentsResult = {
  documents: Array<IKnowledgeDocument & { _id: Types.ObjectId }>;
  nextCursor: string | null;
};

export interface KnowledgeBaseDeps {
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
}

type KnowledgeBaseValue = IKnowledgeBase & { _id: Types.ObjectId };
type KnowledgeDocumentValue = IKnowledgeDocument & { _id: Types.ObjectId };

export interface KnowledgeBaseMethods {
  createKnowledgeBase(input: CreateKnowledgeBaseInput): Promise<KnowledgeBaseValue>;
  getKnowledgeBaseById(id: string | Types.ObjectId): Promise<KnowledgeBaseValue | null>;
  listKnowledgeBases(params: ListKnowledgeBasesParams): Promise<ListKnowledgeBasesResult>;
  updateKnowledgeBase(id: string, input: TUpdateKnowledgeBase): Promise<KnowledgeBaseValue | null>;
  deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }>;
  createKnowledgeDocument(
    knowledgeBaseId: string,
    input: TCreateKnowledgeDocument,
    tenantId?: string,
  ): Promise<KnowledgeDocumentValue | null>;
  listKnowledgeDocuments(
    params: ListKnowledgeDocumentsParams,
  ): Promise<ListKnowledgeDocumentsResult>;
  updateKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
    input: TUpdateKnowledgeDocument,
  ): Promise<KnowledgeDocumentValue | null>;
  deleteKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
  ): Promise<{ deleted: boolean }>;
}

const normalizeLimit = (limit?: number) =>
  Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit as number), 1), 100) : 25;

function parseCursor(
  mongoose: typeof import('mongoose'),
  cursor?: string | null,
): { updatedAt: Date; _id: Types.ObjectId } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64').toString()) as {
      updatedAt?: string;
      id?: string;
    };
    const updatedAt = new Date(value.updatedAt ?? '');
    if (!value.id || !isValidObjectIdString(value.id) || Number.isNaN(updatedAt.getTime())) {
      return null;
    }
    return { updatedAt, _id: new mongoose.Types.ObjectId(value.id) };
  } catch {
    return null;
  }
}

const encodeCursor = (value: { _id: Types.ObjectId; updatedAt?: Date }) =>
  Buffer.from(
    JSON.stringify({
      updatedAt: value.updatedAt?.toISOString() ?? new Date(0).toISOString(),
      id: value._id,
    }),
  ).toString('base64');

export function createKnowledgeBaseMethods(
  mongoose: typeof import('mongoose'),
  deps: KnowledgeBaseDeps,
): KnowledgeBaseMethods {
  const KnowledgeBase = mongoose.models.KnowledgeBase as Model<IKnowledgeBaseDocument>;
  const KnowledgeDocument = mongoose.models.KnowledgeDocument as Model<IKnowledgeDocumentDocument>;

  async function createKnowledgeBase(input: CreateKnowledgeBaseInput) {
    const created = await KnowledgeBase.create({
      ...input,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      documentCount: 0,
    });
    return created.toObject() as IKnowledgeBase & { _id: Types.ObjectId };
  }

  async function getKnowledgeBaseById(id: string | Types.ObjectId) {
    if (!isValidObjectIdString(String(id))) return null;
    return KnowledgeBase.findById(id).lean<IKnowledgeBase & { _id: Types.ObjectId }>();
  }

  async function listKnowledgeBases(
    params: ListKnowledgeBasesParams,
  ): Promise<ListKnowledgeBasesResult> {
    const limit = normalizeLimit(params.limit);
    if (params.accessibleIds.length === 0) return { knowledgeBases: [], nextCursor: null };
    const filter: FilterQuery<IKnowledgeBaseDocument> = { _id: { $in: params.accessibleIds } };
    if (params.search?.trim()) {
      const regex = new RegExp(escapeRegExp(params.search.trim()), 'i');
      filter.$or = [{ name: regex }, { description: regex }];
    }
    const cursor = parseCursor(mongoose, params.cursor);
    if (cursor) {
      filter.$and = [
        {
          $or: [
            { updatedAt: { $lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, _id: { $lt: cursor._id } },
          ],
        },
      ];
    }
    const rows = await KnowledgeBase.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<Array<IKnowledgeBase & { _id: Types.ObjectId }>>();
    const hasMore = rows.length > limit;
    const knowledgeBases = hasMore ? rows.slice(0, limit) : rows;
    return {
      knowledgeBases,
      nextCursor: hasMore ? encodeCursor(knowledgeBases[knowledgeBases.length - 1]) : null,
    };
  }

  async function updateKnowledgeBase(id: string, input: TUpdateKnowledgeBase) {
    if (!isValidObjectIdString(id)) return null;
    return KnowledgeBase.findByIdAndUpdate(
      id,
      { $set: input },
      { new: true, runValidators: true },
    ).lean<IKnowledgeBase & { _id: Types.ObjectId }>();
  }

  async function deleteKnowledgeBase(id: string) {
    if (!isValidObjectIdString(id)) return { deleted: false };
    const resourceId = new mongoose.Types.ObjectId(id);
    const deleted = await KnowledgeBase.findByIdAndDelete(resourceId).lean();
    if (!deleted) return { deleted: false };
    await Promise.all([
      KnowledgeDocument.deleteMany({ knowledgeBaseId: resourceId }),
      deps.removeAllPermissions({ resourceType: 'knowledgeBase', resourceId }),
    ]);
    return { deleted: true };
  }

  async function createKnowledgeDocument(
    knowledgeBaseId: string,
    input: TCreateKnowledgeDocument,
    tenantId?: string,
  ) {
    if (!isValidObjectIdString(knowledgeBaseId)) return null;
    const baseId = new mongoose.Types.ObjectId(knowledgeBaseId);
    if (!(await KnowledgeBase.exists({ _id: baseId }))) return null;
    const created = await KnowledgeDocument.create({
      ...input,
      knowledgeBaseId: baseId,
      tenantId,
      status: 'queued',
    });
    await KnowledgeBase.updateOne({ _id: baseId }, { $inc: { documentCount: 1 } });
    return created.toObject() as IKnowledgeDocument & { _id: Types.ObjectId };
  }

  async function listKnowledgeDocuments(
    params: ListKnowledgeDocumentsParams,
  ): Promise<ListKnowledgeDocumentsResult> {
    const limit = normalizeLimit(params.limit);
    if (!isValidObjectIdString(String(params.knowledgeBaseId))) {
      return { documents: [], nextCursor: null };
    }
    const filter: FilterQuery<IKnowledgeDocumentDocument> = {
      knowledgeBaseId: params.knowledgeBaseId,
    };
    const cursor = parseCursor(mongoose, params.cursor);
    if (cursor) {
      filter.$or = [
        { updatedAt: { $lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, _id: { $lt: cursor._id } },
      ];
    }
    const rows = await KnowledgeDocument.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean<Array<IKnowledgeDocument & { _id: Types.ObjectId }>>();
    const hasMore = rows.length > limit;
    const documents = hasMore ? rows.slice(0, limit) : rows;
    return {
      documents,
      nextCursor: hasMore ? encodeCursor(documents[documents.length - 1]) : null,
    };
  }

  async function updateKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
    input: TUpdateKnowledgeDocument,
  ) {
    if (!isValidObjectIdString(knowledgeBaseId) || !isValidObjectIdString(documentId)) return null;
    return KnowledgeDocument.findOneAndUpdate(
      { _id: documentId, knowledgeBaseId },
      { $set: input },
      { new: true, runValidators: true },
    ).lean<IKnowledgeDocument & { _id: Types.ObjectId }>();
  }

  async function deleteKnowledgeDocument(knowledgeBaseId: string, documentId: string) {
    if (!isValidObjectIdString(knowledgeBaseId) || !isValidObjectIdString(documentId)) {
      return { deleted: false };
    }
    const deleted = await KnowledgeDocument.findOneAndDelete({
      _id: documentId,
      knowledgeBaseId,
    }).lean();
    if (!deleted) return { deleted: false };
    await KnowledgeBase.updateOne(
      { _id: knowledgeBaseId, documentCount: { $gt: 0 } },
      { $inc: { documentCount: -1 } },
    );
    return { deleted: true };
  }

  return {
    createKnowledgeBase,
    getKnowledgeBaseById,
    listKnowledgeBases,
    updateKnowledgeBase,
    deleteKnowledgeBase,
    createKnowledgeDocument,
    listKnowledgeDocuments,
    updateKnowledgeDocument,
    deleteKnowledgeDocument,
  };
}
