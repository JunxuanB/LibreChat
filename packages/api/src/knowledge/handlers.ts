import { logger } from '@librechat/data-schemas';
import {
  AccessRoleIds,
  PermissionBits,
  PrincipalType,
  ResourceType,
  createKnowledgeBaseSchema,
  createKnowledgeDocumentSchema,
  updateKnowledgeBaseSchema,
  updateKnowledgeDocumentSchema,
} from 'librechat-data-provider';
import type { TKnowledgeBase, TKnowledgeDocument } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types';

type Id = { toString(): string };
type KnowledgeBaseRecord = {
  _id: Id;
  name: string;
  description: string;
  author: Id;
  authorName: string;
  documentCount: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
type KnowledgeDocumentRecord = {
  _id: Id;
  knowledgeBaseId: Id;
  file_id?: string;
  name: string;
  mime_type?: string;
  bytes?: number;
  source_type: TKnowledgeDocument['source_type'];
  source_id?: string;
  canonical_url?: string;
  status: TKnowledgeDocument['status'];
  error?: string | null;
  revision?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface KnowledgeHandlersDeps {
  createKnowledgeBase(input: {
    name: string;
    description?: string;
    author: unknown;
    authorName: string;
    tenantId?: string;
  }): Promise<KnowledgeBaseRecord>;
  getKnowledgeBaseById(id: string): Promise<KnowledgeBaseRecord | null>;
  listKnowledgeBases(input: {
    accessibleIds: unknown[];
    search?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ knowledgeBases: KnowledgeBaseRecord[]; nextCursor: string | null }>;
  updateKnowledgeBase(
    id: string,
    input: Record<string, unknown>,
  ): Promise<KnowledgeBaseRecord | null>;
  deleteKnowledgeBase(id: string): Promise<{ deleted: boolean }>;
  createKnowledgeDocument(
    knowledgeBaseId: string,
    input: Record<string, unknown>,
    tenantId?: string,
  ): Promise<KnowledgeDocumentRecord | null>;
  listKnowledgeDocuments(input: {
    knowledgeBaseId: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<{ documents: KnowledgeDocumentRecord[]; nextCursor: string | null }>;
  updateKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
    input: Record<string, unknown>,
  ): Promise<KnowledgeDocumentRecord | null>;
  deleteKnowledgeDocument(
    knowledgeBaseId: string,
    documentId: string,
  ): Promise<{ deleted: boolean }>;
  findAccessibleResources(input: {
    userId: string;
    role?: string | null;
    resourceType: string;
    requiredPermissions: number;
  }): Promise<unknown[]>;
  findPubliclyAccessibleResources(input: {
    resourceType: string;
    requiredPermissions: number;
  }): Promise<unknown[]>;
  grantPermission(input: {
    principalType: string;
    principalId: unknown;
    resourceType: string;
    resourceId: unknown;
    accessRoleId: string;
    grantedBy: unknown;
  }): Promise<unknown>;
}

export interface KnowledgeHandlers {
  list(req: ServerRequest, res: Response): Promise<Response>;
  create(req: ServerRequest, res: Response): Promise<Response>;
  get(req: Request, res: Response): Promise<Response>;
  patch(req: Request, res: Response): Promise<Response>;
  remove(req: Request, res: Response): Promise<Response>;
  listDocuments(req: Request, res: Response): Promise<Response>;
  createDocument(req: ServerRequest, res: Response): Promise<Response>;
  patchDocument(req: Request, res: Response): Promise<Response>;
  removeDocument(req: Request, res: Response): Promise<Response>;
}

const dateString = (value?: Date) => (value ?? new Date()).toISOString();
const serializeBase = (value: KnowledgeBaseRecord): TKnowledgeBase => ({
  _id: value._id.toString(),
  name: value.name,
  description: value.description,
  author: value.author.toString(),
  authorName: value.authorName,
  documentCount: value.documentCount,
  tenantId: value.tenantId,
  createdAt: dateString(value.createdAt),
  updatedAt: dateString(value.updatedAt),
});
const serializeDocument = (value: KnowledgeDocumentRecord): TKnowledgeDocument => ({
  _id: value._id.toString(),
  knowledgeBaseId: value.knowledgeBaseId.toString(),
  file_id: value.file_id,
  name: value.name,
  mime_type: value.mime_type,
  bytes: value.bytes,
  source_type: value.source_type,
  source_id: value.source_id,
  canonical_url: value.canonical_url,
  status: value.status,
  error: value.error,
  revision: value.revision,
  metadata: value.metadata,
  createdAt: dateString(value.createdAt),
  updatedAt: dateString(value.updatedAt),
});
const parseLimit = (value: unknown) => {
  const parsed = Number.parseInt(String(value ?? 25), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 25;
};
const requestUser = (req: ServerRequest) => req.user;

export function createKnowledgeHandlers(deps: KnowledgeHandlersDeps): KnowledgeHandlers {
  async function list(req: ServerRequest, res: Response) {
    try {
      const user = requestUser(req);
      if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
      const [accessible, publiclyAccessible] = await Promise.all([
        deps.findAccessibleResources({
          userId: user.id,
          role: user.role,
          resourceType: ResourceType.KNOWLEDGE_BASE,
          requiredPermissions: PermissionBits.VIEW,
        }),
        deps.findPubliclyAccessibleResources({
          resourceType: ResourceType.KNOWLEDGE_BASE,
          requiredPermissions: PermissionBits.VIEW,
        }),
      ]);
      const ids = Array.from(
        new Map([...accessible, ...publiclyAccessible].map((id) => [String(id), id])).values(),
      );
      const result = await deps.listKnowledgeBases({
        accessibleIds: ids,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
        limit: parseLimit(req.query.limit),
      });
      return res.status(200).json({
        knowledgeBases: result.knowledgeBases.map(serializeBase),
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      logger.error('[knowledge-bases] Error listing knowledge bases', error);
      return res.status(500).json({ error: 'Error listing knowledge bases' });
    }
  }

  async function create(req: ServerRequest, res: Response) {
    const parsed = createKnowledgeBaseSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    const user = requestUser(req);
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    try {
      const base = await deps.createKnowledgeBase({
        ...parsed.data,
        author: user._id ?? user.id,
        authorName: user.name ?? user.username ?? 'Unknown',
        tenantId: user.tenantId,
      });
      try {
        await deps.grantPermission({
          principalType: PrincipalType.USER,
          principalId: user.id,
          resourceType: ResourceType.KNOWLEDGE_BASE,
          resourceId: base._id,
          accessRoleId: AccessRoleIds.KNOWLEDGE_BASE_OWNER,
          grantedBy: user.id,
        });
      } catch (error) {
        await deps.deleteKnowledgeBase(base._id.toString());
        throw error;
      }
      return res.status(201).json(serializeBase(base));
    } catch (error) {
      logger.error('[knowledge-bases] Error creating knowledge base', error);
      return res.status(500).json({ error: 'Error creating knowledge base' });
    }
  }

  async function get(req: Request, res: Response) {
    const base = await deps.getKnowledgeBaseById(req.params.id);
    return base
      ? res.status(200).json(serializeBase(base))
      : res.status(404).json({ error: 'Knowledge base not found' });
  }

  async function patch(req: Request, res: Response) {
    const parsed = updateKnowledgeBaseSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    const base = await deps.updateKnowledgeBase(req.params.id, parsed.data);
    return base
      ? res.status(200).json(serializeBase(base))
      : res.status(404).json({ error: 'Knowledge base not found' });
  }

  async function remove(req: Request, res: Response) {
    const result = await deps.deleteKnowledgeBase(req.params.id);
    return result.deleted
      ? res.status(200).json(result)
      : res.status(404).json({ error: 'Knowledge base not found' });
  }

  async function listDocuments(req: Request, res: Response) {
    const result = await deps.listKnowledgeDocuments({
      knowledgeBaseId: req.params.id,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
      limit: parseLimit(req.query.limit),
    });
    return res.status(200).json({
      documents: result.documents.map(serializeDocument),
      nextCursor: result.nextCursor,
    });
  }

  async function createDocument(req: ServerRequest, res: Response) {
    const parsed = createKnowledgeDocumentSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    const { id } = req.params as { id: string };
    const document = await deps.createKnowledgeDocument(id, parsed.data, req.user?.tenantId);
    return document
      ? res.status(201).json(serializeDocument(document))
      : res.status(404).json({ error: 'Knowledge base not found' });
  }

  async function patchDocument(req: Request, res: Response) {
    const parsed = updateKnowledgeDocumentSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    const document = await deps.updateKnowledgeDocument(
      req.params.id,
      req.params.documentId,
      parsed.data,
    );
    return document
      ? res.status(200).json(serializeDocument(document))
      : res.status(404).json({ error: 'Knowledge document not found' });
  }

  async function removeDocument(req: Request, res: Response) {
    const result = await deps.deleteKnowledgeDocument(req.params.id, req.params.documentId);
    return result.deleted
      ? res.status(200).json(result)
      : res.status(404).json({ error: 'Knowledge document not found' });
  }

  return {
    list,
    create,
    get,
    patch,
    remove,
    listDocuments,
    createDocument,
    patchDocument,
    removeDocument,
  };
}
