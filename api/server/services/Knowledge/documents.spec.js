const fs = require('fs');
const { Readable } = require('stream');

jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/services/Files/VectorDB/crud', () => ({
  deleteVectors: jest.fn(),
  uploadVectors: jest.fn(),
}));

const { createKnowledgeDocumentIngestionService } = require('./documents');

const req = { user: { id: 'user-1', _id: 'user-1', tenantId: 'tenant-1' } };
const file = {
  file_id: 'file-1',
  filename: 'policy.txt',
  type: 'text/plain',
  bytes: 6,
  source: 'local',
  filepath: '/uploads/user-1/policy.txt',
};
const queued = {
  _id: { toString: () => 'document-1' },
  knowledgeBaseId: { toString: () => 'kb-1' },
  file_id: 'file-1',
  status: 'queued',
};

function build() {
  const ready = { ...queued, status: 'ready' };
  const database = {
    findFileById: jest.fn(async () => file),
    createKnowledgeDocument: jest.fn(async () => queued),
    updateKnowledgeDocument: jest.fn(async (_kb, _id, update) => ({ ...queued, ...update })),
  };
  const getDownloadStream = jest.fn(async () => Readable.from(['policy']));
  const uploadVectors = jest.fn(async () => ({ embedded: true }));
  const deleteVectors = jest.fn(async () => undefined);
  const ingest = createKnowledgeDocumentIngestionService({
    db: database,
    getStrategyFunctions: () => ({ getDownloadStream }),
    uploadVectors,
    deleteVectors,
  });
  return { ready, database, getDownloadStream, uploadVectors, deleteVectors, ingest };
}

describe('knowledge document ingestion', () => {
  it('copies an owned file into the KB vector namespace without modifying the original file', async () => {
    const { ingest, database, uploadVectors } = build();
    let tempPath;
    uploadVectors.mockImplementation(async ({ file: upload, entity_id }) => {
      tempPath = upload.path;
      expect(entity_id).toBe('kb-1');
      expect(fs.readFileSync(tempPath, 'utf8')).toBe('policy');
      return { embedded: true };
    });

    const result = await ingest('kb-1', { file_id: 'file-1', name: 'spoofed' }, req);

    expect(database.findFileById).toHaveBeenCalledWith('file-1', { user: 'user-1' });
    expect(database.createKnowledgeDocument).toHaveBeenCalledWith(
      'kb-1',
      expect.objectContaining({ name: 'policy.txt', source_type: 'upload' }),
      'tenant-1',
    );
    expect(database.updateKnowledgeDocument).toHaveBeenCalledWith('kb-1', 'document-1', {
      status: 'ready',
      error: null,
    });
    expect(result.status).toBe('ready');
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('marks the KB document failed and cleans only its entity scope when embedding fails', async () => {
    const { ingest, database, uploadVectors, deleteVectors } = build();
    uploadVectors.mockRejectedValue(new Error('embedding failed'));

    const result = await ingest('kb-1', { file_id: 'file-1', name: 'Policy' }, req);

    expect(deleteVectors).toHaveBeenCalledWith(req, { file_id: 'file-1', embedded: true }, 'kb-1');
    expect(database.updateKnowledgeDocument).toHaveBeenLastCalledWith('kb-1', 'document-1', {
      status: 'failed',
      error: 'embedding failed',
    });
    expect(result.status).toBe('failed');
  });
});
