import {
  queryKnowledgeFiles,
  resolveAuthorizedKnowledgeFiles,
  type KnowledgeRetrievalDependencies,
  type RagQueryClient,
} from './retrieval';

describe('knowledge retrieval', () => {
  const dependencies = (
    overrides: Partial<KnowledgeRetrievalDependencies> = {},
  ): KnowledgeRetrievalDependencies => ({
    authorizeKnowledgeBases: jest.fn(
      async ({ knowledgeBaseIds }: { knowledgeBaseIds: string[] }) => knowledgeBaseIds,
    ),
    getKnowledgeDocuments: jest.fn(async () => []),
    ...overrides,
  });

  it('fails closed when any requested knowledge base is not authorized', async () => {
    const deps = dependencies({
      authorizeKnowledgeBases: jest.fn(async () => ['kb-allowed']),
    });

    await expect(
      resolveAuthorizedKnowledgeFiles(
        {
          knowledgeBaseIds: ['kb-allowed', 'kb-denied'],
          userId: 'user-1',
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: 'KnowledgeBaseAccessError',
      deniedKnowledgeBaseIds: ['kb-denied'],
    });
    expect(deps.getKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it('returns only ready, live documents in the authorized collections', async () => {
    const deps = dependencies({
      getKnowledgeDocuments: jest.fn(async () => [
        { knowledgeBaseId: 'kb-1', file_id: 'file-1', name: 'one.pdf', status: 'ready' },
        { knowledgeBaseId: 'kb-1', file_id: 'file-2', name: 'two.pdf', status: 'failed' },
        {
          knowledgeBaseId: 'kb-other',
          file_id: 'file-3',
          name: 'three.pdf',
          status: 'ready',
        },
        {
          knowledgeBaseId: 'kb-2',
          file_id: 'file-4',
          name: 'four.pdf',
          status: 'ready',
        },
        {
          knowledgeBaseId: 'kb-2',
          file_id: 'file-1',
          name: 'duplicate.pdf',
          status: 'ready',
        },
      ]),
    });

    await expect(
      resolveAuthorizedKnowledgeFiles(
        { knowledgeBaseIds: ['kb-1', 'kb-2'], userId: 'user-1', role: 'USER' },
        deps,
      ),
    ).resolves.toEqual([
      {
        file_id: 'file-1',
        filename: 'one.pdf',
        knowledge_base_id: 'kb-1',
        fromKnowledgeBase: true,
      },
      {
        file_id: 'file-4',
        filename: 'four.pdf',
        knowledge_base_id: 'kb-2',
        fromKnowledgeBase: true,
      },
      {
        file_id: 'file-1',
        filename: 'duplicate.pdf',
        knowledge_base_id: 'kb-2',
        fromKnowledgeBase: true,
      },
    ]);
  });

  it('queries each knowledge-base namespace once and ranks results globally', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: [[{ page_content: 'second' }, 0.4]] })
      .mockResolvedValueOnce({ data: [[{ page_content: 'first' }, 0.1]] });

    await queryKnowledgeFiles(
      {
        ragApiUrl: 'http://rag.internal/',
        jwtToken: 'token',
        query: 'retention policy',
        files: [
          { file_id: 'file-1', knowledge_base_id: 'kb-1' },
          { file_id: 'file-2', knowledge_base_id: 'kb-2' },
          { file_id: 'file-1', knowledge_base_id: 'kb-1' },
        ],
      },
      { post } as RagQueryClient,
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledWith(
      'http://rag.internal/query_multiple',
      { query: 'retention policy', file_ids: ['file-1'], k: 10, entity_id: 'kb-1' },
      {
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      'http://rag.internal/query_multiple',
      { query: 'retention policy', file_ids: ['file-2'], k: 10, entity_id: 'kb-2' },
      expect.any(Object),
    );
  });

  it('keeps healthy namespace results when another selected knowledge base fails', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ data: [[{ page_content: 'healthy result' }, 0.2]] })
      .mockRejectedValueOnce(new Error('namespace unavailable'));

    await expect(
      queryKnowledgeFiles(
        {
          ragApiUrl: 'http://rag.internal',
          jwtToken: 'token',
          query: 'policy',
          files: [
            { file_id: 'file-1', knowledge_base_id: 'kb-healthy' },
            { file_id: 'file-2', knowledge_base_id: 'kb-failing' },
          ],
        },
        { post } as RagQueryClient,
      ),
    ).resolves.toEqual([
      [
        {
          page_content: 'healthy result',
          metadata: { knowledge_base_id: 'kb-healthy' },
        },
        0.2,
      ],
    ]);
  });

  it('chunks large knowledge bases without omitting searchable file IDs', async () => {
    const post = jest.fn(async () => ({ data: [] }));
    const files = Array.from({ length: 501 }, (_, index) => ({
      file_id: `file-${index}`,
      knowledge_base_id: 'kb-large',
    }));

    await queryKnowledgeFiles(
      {
        ragApiUrl: 'http://rag.internal',
        jwtToken: 'token',
        query: 'policy',
        files,
      },
      { post } as RagQueryClient,
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].file_ids).toHaveLength(500);
    expect(post.mock.calls[1][1].file_ids).toEqual(['file-500']);
  });

  it('rejects when every selected knowledge-base namespace fails', async () => {
    const post = jest.fn().mockRejectedValue(new Error('rag unavailable'));

    await expect(
      queryKnowledgeFiles(
        {
          ragApiUrl: 'http://rag.internal',
          jwtToken: 'token',
          query: 'policy',
          files: [{ file_id: 'file-1', knowledge_base_id: 'kb-1' }],
        },
        { post } as RagQueryClient,
      ),
    ).rejects.toThrow('rag unavailable');
  });
});
