import type {
  TCreateKnowledgeBase,
  TCreateKnowledgeDocument,
  TUpdateKnowledgeBase,
  TUpdateKnowledgeDocument,
  TCreateKnowledgeSource,
  TUpdateKnowledgeSource,
} from 'librechat-data-provider';
import type { FilterQuery, Model, Types } from 'mongoose';
import type {
  IKnowledgeBase,
  IKnowledgeBaseDocument,
  IKnowledgeDocument,
  IKnowledgeDocumentDocument,
  IKnowledgeConnectionDocument,
  IKnowledgeSource,
  IKnowledgeSourceDocument,
} from '~/types';
import { encryptV2, decryptV2 } from '~/crypto';
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
type KnowledgeRetrievalDocument = KnowledgeDocumentValue & {
  knowledgeBaseName?: string;
  knowledgeSourceName?: string;
};
export type KnowledgeSourceValue = IKnowledgeSource & {
  _id: Types.ObjectId;
  connection?: {
    _id: string;
    name: string;
    provider: IKnowledgeSource['type'];
    hasSecrets: boolean;
  };
};

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
  listKnowledgeSources(knowledgeBaseId: string): Promise<KnowledgeSourceValue[]>;
  createKnowledgeSource(input: {
    knowledgeBaseId: string;
    owner: Types.ObjectId;
    tenantId?: string;
    source: TCreateKnowledgeSource;
  }): Promise<KnowledgeSourceValue | null>;
  updateKnowledgeSource(
    knowledgeBaseId: string,
    sourceId: string,
    input: TUpdateKnowledgeSource,
  ): Promise<KnowledgeSourceValue | null>;
  deleteKnowledgeSource(knowledgeBaseId: string, sourceId: string): Promise<{ deleted: boolean }>;
  getKnowledgeConnectionSecrets(
    connectionId: string | Types.ObjectId,
  ): Promise<Record<string, string> | null>;
  findKnowledgeDocumentsByBaseIds(knowledgeBaseIds: string[]): Promise<KnowledgeDocumentValue[]>;
  getKnowledgeDocuments(input: {
    knowledgeBaseIds: string[];
  }): Promise<KnowledgeRetrievalDocument[]>;
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
  const KnowledgeConnection = mongoose.models
    .KnowledgeConnection as Model<IKnowledgeConnectionDocument>;
  const KnowledgeSource = mongoose.models.KnowledgeSource as Model<IKnowledgeSourceDocument>;

  async function withConnection(
    source: IKnowledgeSource & { _id: Types.ObjectId },
  ): Promise<KnowledgeSourceValue> {
    if (!source.connectionId) return source;
    const connection = await KnowledgeConnection.findById(source.connectionId).lean();
    return {
      ...source,
      connection: connection
        ? {
            _id: String(connection._id),
            name: connection.name,
            provider: connection.provider,
            hasSecrets: true,
          }
        : undefined,
    };
  }

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
    const connections = await KnowledgeSource.find({ knowledgeBaseId: resourceId }).distinct(
      'connectionId',
    );
    await Promise.all([
      KnowledgeDocument.deleteMany({ knowledgeBaseId: resourceId }),
      KnowledgeSource.deleteMany({ knowledgeBaseId: resourceId }),
      KnowledgeConnection.deleteMany({ _id: { $in: connections } }),
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

  async function listKnowledgeSources(knowledgeBaseId: string): Promise<KnowledgeSourceValue[]> {
    if (!isValidObjectIdString(knowledgeBaseId)) return [];
    const sources = await KnowledgeSource.find({ knowledgeBaseId })
      .sort({ createdAt: -1 })
      .lean<Array<IKnowledgeSource & { _id: Types.ObjectId }>>();
    return Promise.all(sources.map(withConnection));
  }

  async function createKnowledgeSource(input: {
    knowledgeBaseId: string;
    owner: Types.ObjectId;
    tenantId?: string;
    source: TCreateKnowledgeSource;
  }): Promise<KnowledgeSourceValue | null> {
    if (
      !isValidObjectIdString(input.knowledgeBaseId) ||
      !(await KnowledgeBase.exists({ _id: input.knowledgeBaseId }))
    )
      return null;
    let connectionId: Types.ObjectId | undefined;
    if (input.source.credentials) {
      const encryptedSecrets = await encryptV2(JSON.stringify(input.source.credentials));
      const connection = await KnowledgeConnection.create({
        name: input.source.name,
        provider: input.source.type,
        owner: input.owner,
        encryptedSecrets,
        tenantId: input.tenantId,
      });
      connectionId = connection._id;
    }
    try {
      const source = await KnowledgeSource.create({
        knowledgeBaseId: input.knowledgeBaseId,
        connectionId,
        owner: input.owner,
        name: input.source.name,
        type: input.source.type,
        accessMode: input.source.accessMode,
        config: input.source.config,
        tenantId: input.tenantId,
      });
      return withConnection(source.toObject() as IKnowledgeSource & { _id: Types.ObjectId });
    } catch (error) {
      if (connectionId) await KnowledgeConnection.deleteOne({ _id: connectionId });
      throw error;
    }
  }

  async function updateKnowledgeSource(
    knowledgeBaseId: string,
    sourceId: string,
    input: TUpdateKnowledgeSource,
  ): Promise<KnowledgeSourceValue | null> {
    if (!isValidObjectIdString(knowledgeBaseId) || !isValidObjectIdString(sourceId)) return null;
    const source = await KnowledgeSource.findOne({ _id: sourceId, knowledgeBaseId });
    if (!source) return null;
    if (input.credentials) {
      const encryptedSecrets = await encryptV2(JSON.stringify(input.credentials));
      if (source.connectionId) {
        await KnowledgeConnection.updateOne(
          { _id: source.connectionId },
          { $set: { name: input.name ?? source.name, encryptedSecrets } },
        );
      } else {
        const connection = await KnowledgeConnection.create({
          name: input.name ?? source.name,
          provider: source.type,
          owner: source.owner,
          encryptedSecrets,
          tenantId: source.tenantId,
        });
        source.connectionId = connection._id;
      }
    }
    const { credentials: _credentials, lastSyncedAt, ...rest } = input;
    Object.assign(
      source,
      rest,
      lastSyncedAt === undefined
        ? {}
        : { lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt) : null },
    );
    await source.save();
    return withConnection(source.toObject() as IKnowledgeSource & { _id: Types.ObjectId });
  }

  async function deleteKnowledgeSource(knowledgeBaseId: string, sourceId: string) {
    if (!isValidObjectIdString(knowledgeBaseId) || !isValidObjectIdString(sourceId))
      return { deleted: false };
    const source = await KnowledgeSource.findOneAndDelete({
      _id: sourceId,
      knowledgeBaseId,
    }).lean();
    if (!source) return { deleted: false };
    if (source.connectionId) await KnowledgeConnection.deleteOne({ _id: source.connectionId });
    return { deleted: true };
  }

  async function getKnowledgeConnectionSecrets(connectionId: string | Types.ObjectId) {
    if (!isValidObjectIdString(String(connectionId))) return null;
    const connection = await KnowledgeConnection.findById(connectionId)
      .select('+encryptedSecrets')
      .lean();
    if (!connection?.encryptedSecrets) return null;
    return JSON.parse(await decryptV2(connection.encryptedSecrets)) as Record<string, string>;
  }

  async function findKnowledgeDocumentsByBaseIds(knowledgeBaseIds: string[]) {
    const ids = knowledgeBaseIds
      .filter(isValidObjectIdString)
      .map((id) => new mongoose.Types.ObjectId(id));
    if (ids.length === 0) return [];
    return KnowledgeDocument.find({ knowledgeBaseId: { $in: ids }, status: 'ready' })
      .select('knowledgeBaseId knowledgeSourceId file_id name status source_type canonical_url')
      .lean<KnowledgeDocumentValue[]>();
  }

  const getKnowledgeDocuments = async (input: { knowledgeBaseIds: string[] }) => {
    const documents = await findKnowledgeDocumentsByBaseIds(input.knowledgeBaseIds);
    if (documents.length === 0) return [];
    const baseIds = [...new Set(documents.map((document) => String(document.knowledgeBaseId)))];
    const sourceIds = [
      ...new Set(
        documents
          .map((document) => document.knowledgeSourceId && String(document.knowledgeSourceId))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const [bases, sources] = await Promise.all([
      KnowledgeBase.find({ _id: { $in: baseIds } })
        .select('_id name')
        .lean<KnowledgeBaseValue[]>(),
      sourceIds.length > 0
        ? KnowledgeSource.find({ _id: { $in: sourceIds } })
            .select('_id name')
            .lean<KnowledgeSourceValue[]>()
        : [],
    ]);
    const baseNames = new Map(bases.map((base) => [String(base._id), base.name]));
    const sourceNames = new Map(sources.map((source) => [String(source._id), source.name]));
    return documents.map((document) => ({
      ...document,
      knowledgeBaseName: baseNames.get(String(document.knowledgeBaseId)),
      knowledgeSourceName: document.knowledgeSourceId
        ? sourceNames.get(String(document.knowledgeSourceId))
        : undefined,
    }));
  };

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
    listKnowledgeSources,
    createKnowledgeSource,
    updateKnowledgeSource,
    deleteKnowledgeSource,
    getKnowledgeConnectionSecrets,
    findKnowledgeDocumentsByBaseIds,
    getKnowledgeDocuments,
  };
}
