import { apiBaseUrl, dataService, request } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type {
  KnowledgeBase,
  KnowledgeBaseInput,
  KnowledgeBaseListResponse,
  KnowledgeConnectorListResponse,
  KnowledgeDocument,
  KnowledgeSource,
  KnowledgeSourceInput,
  KnowledgeSourceUpdateInput,
  KnowledgeSourceListResponse,
} from './types';

const base = () => `${apiBaseUrl()}/api/knowledge-bases`;
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

async function listAllKnowledgeBases() {
  const knowledgeBases: KnowledgeBaseListResponse['knowledgeBases'] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await dataService.listKnowledgeBases({ limit: PAGE_LIMIT, cursor });
    knowledgeBases.push(...page.knowledgeBases);
    if (!page.nextCursor) return { knowledgeBases, nextCursor: null };
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Knowledge-base pagination returned a repeated cursor');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Knowledge-base pagination exceeded its safety limit');
}

async function listAllKnowledgeDocuments(id: string) {
  const documents: KnowledgeDocument[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await dataService.listKnowledgeDocuments(id, { limit: PAGE_LIMIT, cursor });
    documents.push(...page.documents);
    if (!page.nextCursor) return documents;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Knowledge-document pagination returned a repeated cursor');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Knowledge-document pagination exceeded its safety limit');
}

/** Keep the provisional backend contract in one place while the stacked PRs converge. */
export const knowledgeBaseApi = {
  list() {
    return listAllKnowledgeBases();
  },
  async get(id: string): Promise<KnowledgeBase> {
    const [knowledgeBase, documentPage] = await Promise.all([
      dataService.getKnowledgeBase(id),
      listAllKnowledgeDocuments(id),
    ]);
    return { ...knowledgeBase, documents: documentPage };
  },
  create(input: KnowledgeBaseInput): Promise<KnowledgeBase> {
    return dataService.createKnowledgeBase(input);
  },
  update(id: string, input: KnowledgeBaseInput): Promise<KnowledgeBase> {
    return dataService.updateKnowledgeBase(id, input);
  },
  remove(id: string): Promise<void> {
    return dataService.deleteKnowledgeBase(id).then(() => undefined);
  },
  async addDocument(id: string, file: TFile) {
    return dataService.createKnowledgeDocument(id, {
      file_id: file.file_id,
      name: file.filename,
      mime_type: file.type,
      bytes: file.bytes,
      source_type: 'upload',
    });
  },
  removeDocument(id: string, documentId: string): Promise<void> {
    return dataService.deleteKnowledgeDocument(id, documentId).then(() => undefined);
  },
  async connectors(): Promise<KnowledgeConnectorListResponse> {
    try {
      const response = await request.get<
        KnowledgeConnectorListResponse['connectors'] | KnowledgeConnectorListResponse
      >(`${base()}/connectors`);
      return Array.isArray(response) ? { connectors: response } : response;
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) {
        return { connectors: [] };
      }
      throw error;
    }
  },
  async sources(id: string): Promise<KnowledgeSourceListResponse> {
    const response = await request.get<KnowledgeSource[] | KnowledgeSourceListResponse>(
      `${base()}/${encodeURIComponent(id)}/sources`,
    );
    return Array.isArray(response) ? { sources: response } : response;
  },
  createSource(id: string, input: KnowledgeSourceInput): Promise<KnowledgeSource> {
    return request.post(`${base()}/${encodeURIComponent(id)}/sources`, input);
  },
  updateSource(
    id: string,
    sourceId: string,
    input: KnowledgeSourceUpdateInput,
  ): Promise<KnowledgeSource> {
    return request.patch(
      `${base()}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`,
      input,
    );
  },
  removeSource(id: string, sourceId: string): Promise<void> {
    return request
      .delete(`${base()}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`)
      .then(() => undefined);
  },
  syncSource(id: string, sourceId: string): Promise<KnowledgeSource> {
    return request.post(
      `${base()}/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}/sync`,
      {},
    );
  },
};
