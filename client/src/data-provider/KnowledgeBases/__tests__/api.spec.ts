import { dataService, request } from 'librechat-data-provider';
import { knowledgeBaseApi } from '../api';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  dataService: {
    listKnowledgeBases: jest.fn(),
    getKnowledgeBase: jest.fn(),
    listKnowledgeDocuments: jest.fn(),
    createKnowledgeDocument: jest.fn(),
  },
  request: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

describe('knowledgeBaseApi', () => {
  it('loads every knowledge-base page for selectors and the side panel', async () => {
    (dataService.listKnowledgeBases as jest.Mock)
      .mockResolvedValueOnce({
        knowledgeBases: [{ _id: 'kb-1', name: 'First' }],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        knowledgeBases: [{ _id: 'kb-26', name: 'Later' }],
        nextCursor: null,
      });

    await expect(knowledgeBaseApi.list()).resolves.toMatchObject({
      knowledgeBases: [{ _id: 'kb-1' }, { _id: 'kb-26' }],
      nextCursor: null,
    });
    expect(dataService.listKnowledgeBases).toHaveBeenNthCalledWith(1, {
      limit: 100,
      cursor: undefined,
    });
    expect(dataService.listKnowledgeBases).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cursor: 'cursor-2',
    });
  });

  it('combines base details with their document page', async () => {
    (dataService.getKnowledgeBase as jest.Mock).mockResolvedValue({
      _id: 'kb-1',
      name: 'Handbook',
    });
    (dataService.listKnowledgeDocuments as jest.Mock).mockResolvedValue({
      documents: [{ _id: 'doc-1', name: 'Guide', status: 'ready' }],
      nextCursor: null,
    });

    await expect(knowledgeBaseApi.get('kb-1')).resolves.toMatchObject({
      _id: 'kb-1',
      documents: [{ _id: 'doc-1' }],
    });
  });

  it('loads every document page for management and duplicate detection', async () => {
    (dataService.getKnowledgeBase as jest.Mock).mockResolvedValue({
      _id: 'kb-1',
      name: 'Handbook',
    });
    (dataService.listKnowledgeDocuments as jest.Mock)
      .mockResolvedValueOnce({
        documents: [{ _id: 'doc-1', name: 'First' }],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        documents: [{ _id: 'doc-26', name: 'Later' }],
        nextCursor: null,
      });

    await expect(knowledgeBaseApi.get('kb-1')).resolves.toMatchObject({
      documents: [{ _id: 'doc-1' }, { _id: 'doc-26' }],
    });
    expect(dataService.listKnowledgeDocuments).toHaveBeenNthCalledWith(2, 'kb-1', {
      limit: 100,
      cursor: 'cursor-2',
    });
  });

  it('treats a missing connector catalog as an empty catalog', async () => {
    (request.get as jest.Mock).mockRejectedValue({ response: { status: 404 } });
    await expect(knowledgeBaseApi.connectors()).resolves.toEqual({ connectors: [] });
  });

  it('uses the source collection and sync routes', async () => {
    (request.get as jest.Mock).mockResolvedValue({ sources: [] });
    (request.post as jest.Mock).mockResolvedValue({ _id: 'source-1' });

    await knowledgeBaseApi.sources('kb 1');
    await knowledgeBaseApi.syncSource('kb 1', 'source/1');

    expect(request.get).toHaveBeenCalledWith('/api/knowledge-bases/kb%201/sources');
    expect(request.post).toHaveBeenCalledWith(
      '/api/knowledge-bases/kb%201/sources/source%2F1/sync',
      {},
    );
  });
});
