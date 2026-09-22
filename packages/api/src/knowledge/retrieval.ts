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
  const seenFiles = new Set<string>();
  const files: KnowledgeFile[] = [];

  for (const document of documents) {
    const knowledgeBaseId = document.knowledgeBaseId.toString();
    if (!authorizedSet.has(knowledgeBaseId) || document.status !== 'ready') {
      continue;
    }

    const fileId = document.file_id?.trim();
    const filename = document.name?.trim();
    const key = `${knowledgeBaseId}\0${fileId}`;
    if (!fileId || !filename || seenFiles.has(key)) {
      continue;
    }

    seenFiles.add(key);
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
    body: { query: string; file_ids: string[]; k: number; entity_id: string },
    config: { headers: Record<string, string> },
  ): Promise<{ data: RagQueryResult[] }>;
}

export interface QueryKnowledgeFilesInput {
  ragApiUrl: string;
  jwtToken: string;
  query: string;
  files: readonly Pick<KnowledgeFile, 'file_id' | 'knowledge_base_id'>[];
  k?: number;
}

const MAX_FILE_IDS_PER_QUERY = 500;

/** Query each authorized vector namespace once, then rank all collection results together. */
export async function queryKnowledgeFiles(
  input: QueryKnowledgeFilesInput,
  client: RagQueryClient,
): Promise<RagQueryResult[]> {
  const filesByKnowledgeBase = new Map<string, string[]>();
  for (const file of input.files) {
    const knowledgeBaseId = file.knowledge_base_id?.trim();
    const fileId = file.file_id?.trim();
    if (!knowledgeBaseId || !fileId) continue;
    const fileIds = filesByKnowledgeBase.get(knowledgeBaseId) ?? [];
    if (!fileIds.includes(fileId)) fileIds.push(fileId);
    filesByKnowledgeBase.set(knowledgeBaseId, fileIds);
  }
  if (filesByKnowledgeBase.size === 0) {
    return [];
  }

  const k = input.k ?? 10;
  const queries = [...filesByKnowledgeBase].flatMap(([knowledgeBaseId, fileIds]) => {
    const chunks = [];
    for (let offset = 0; offset < fileIds.length; offset += MAX_FILE_IDS_PER_QUERY) {
      chunks.push({
        knowledgeBaseId,
        fileIds: fileIds.slice(offset, offset + MAX_FILE_IDS_PER_QUERY),
      });
    }
    return chunks;
  });
  const responses = await Promise.allSettled(
    queries.map(async ({ knowledgeBaseId, fileIds }) => {
      const response = await client.post(
        `${input.ragApiUrl.replace(/\/$/, '')}/query_multiple`,
        {
          query: input.query,
          file_ids: fileIds,
          k,
          entity_id: knowledgeBaseId,
        },
        {
          headers: {
            Authorization: `Bearer ${input.jwtToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      return { knowledgeBaseId, data: response.data };
    }),
  );

  const successfulResponses = responses.filter(
    (
      response,
    ): response is PromiseFulfilledResult<{ knowledgeBaseId: string; data: RagQueryResult[] }> =>
      response.status === 'fulfilled',
  );
  if (successfulResponses.length === 0) {
    const firstFailure = responses.find(
      (response): response is PromiseRejectedResult => response.status === 'rejected',
    );
    throw firstFailure?.reason ?? new Error('All knowledge-base queries failed');
  }

  return successfulResponses
    .flatMap(({ value }) =>
      Array.isArray(value.data)
        ? value.data.map(
            ([document, distance]): RagQueryResult => [
              {
                ...document,
                metadata: { ...document.metadata, knowledge_base_id: value.knowledgeBaseId },
              },
              distance,
            ],
          )
        : [],
    )
    .sort((left, right) => left[1] - right[1])
    .slice(0, k);
}
