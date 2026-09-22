export interface KnowledgeFile {
  file_id: string;
  filename: string;
  knowledge_base_id: string;
  knowledge_base_name?: string;
  knowledge_source_name?: string;
  source_type?: string;
  canonical_url?: string;
  fromKnowledgeBase: true;
}

export interface KnowledgeDocumentRecord {
  knowledgeBaseId: string | { toString(): string };
  file_id?: string;
  name: string;
  status: string;
  canonical_url?: string;
  source_type?: string;
  knowledgeBaseName?: string;
  knowledgeSourceName?: string;
}

export interface KnowledgeAuthorizationInput {
  knowledgeBaseIds: string[];
  userId: string;
  role?: string;
}

export interface KnowledgeDocumentQuery {
  knowledgeBaseIds: string[];
}

export interface KnowledgeRetrievalDependencies {
  authorizeKnowledgeBases(input: KnowledgeAuthorizationInput): Promise<readonly string[]>;
  getKnowledgeDocuments(query: KnowledgeDocumentQuery): Promise<readonly KnowledgeDocumentRecord[]>;
}

export interface ResolveKnowledgeFilesInput extends KnowledgeAuthorizationInput {}

export class KnowledgeBaseAccessError extends Error {
  readonly deniedKnowledgeBaseIds: string[];

  constructor(deniedKnowledgeBaseIds: string[]) {
    super('One or more knowledge bases are unavailable');
    this.name = 'KnowledgeBaseAccessError';
    this.deniedKnowledgeBaseIds = deniedKnowledgeBaseIds;
  }
}

const uniqueIds = (ids: readonly string[]): string[] =>
  Array.from(
    new Set(
      ids
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );

/**
 * Resolves vector file IDs only after the LibreChat control plane has authorized
 * every requested knowledge base. The injected dependencies are the seam for
 * the knowledge-base model and ACL methods; the RAG API is never asked to make
 * an access-control decision.
 */
export async function resolveAuthorizedKnowledgeFiles(
  input: ResolveKnowledgeFilesInput,
  dependencies: KnowledgeRetrievalDependencies,
): Promise<KnowledgeFile[]> {
  if (typeof input.userId !== 'string' || input.userId.trim() === '') {
    throw new KnowledgeBaseAccessError(uniqueIds(input.knowledgeBaseIds));
  }
  const requestedIds = uniqueIds(input.knowledgeBaseIds);
  if (requestedIds.length === 0) {
    return [];
  }

  const authorizedIds = uniqueIds(
    await dependencies.authorizeKnowledgeBases({
      knowledgeBaseIds: requestedIds,
      userId: input.userId,
      role: input.role,
    }),
  );
  const authorizedSet = new Set(authorizedIds);
  const deniedIds = requestedIds.filter((id) => !authorizedSet.has(id));
  if (deniedIds.length > 0) {
    throw new KnowledgeBaseAccessError(deniedIds);
  }

  const documents = await dependencies.getKnowledgeDocuments({ knowledgeBaseIds: requestedIds });
  const seenFileIds = new Set<string>();
  const files: KnowledgeFile[] = [];

  for (const document of documents) {
    const knowledgeBaseId = document.knowledgeBaseId.toString();
    if (!authorizedSet.has(knowledgeBaseId) || document.status !== 'ready') {
      continue;
    }

    const fileId = document.file_id?.trim();
    const filename = document.name?.trim();
    if (!fileId || !filename || seenFileIds.has(fileId)) {
      continue;
    }

    seenFileIds.add(fileId);
    files.push({
      file_id: fileId,
      filename,
      knowledge_base_id: knowledgeBaseId,
      knowledge_base_name: document.knowledgeBaseName,
      knowledge_source_name: document.knowledgeSourceName,
      source_type: document.source_type,
      canonical_url: document.canonical_url,
      fromKnowledgeBase: true,
    });
  }

  return files;
}

export type RagQueryResult = [
  {
    page_content: string;
    metadata?: Record<string, unknown>;
  },
  number,
];

export interface RagQueryClient {
  post(
    url: string,
    body: { query: string; file_ids: string[]; k: number },
    config: { headers: Record<string, string> },
  ): Promise<{ data: RagQueryResult[] }>;
}

export interface QueryKnowledgeFilesInput {
  ragApiUrl: string;
  jwtToken: string;
  query: string;
  files: readonly Pick<KnowledgeFile, 'file_id'>[];
  k?: number;
}

/** Make one collection query for all authorized knowledge-base documents. */
export async function queryKnowledgeFiles(
  input: QueryKnowledgeFilesInput,
  client: RagQueryClient,
): Promise<RagQueryResult[]> {
  const fileIds = uniqueIds(input.files.map((file) => file.file_id));
  if (fileIds.length === 0) {
    return [];
  }

  const response = await client.post(
    `${input.ragApiUrl.replace(/\/$/, '')}/query_multiple`,
    {
      query: input.query,
      file_ids: fileIds,
      k: input.k ?? 10,
    },
    {
      headers: {
        Authorization: `Bearer ${input.jwtToken}`,
        'Content-Type': 'application/json',
      },
    },
  );

  return Array.isArray(response.data) ? response.data : [];
}
