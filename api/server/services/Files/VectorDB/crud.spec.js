const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  generateShortLivedToken: jest.fn(() => 'token'),
  logAxiosError: jest.fn(),
}));

const { deleteVectors } = require('./crud');

describe('VectorDB deletion', () => {
  const previousRagApiUrl = process.env.RAG_API_URL;

  afterEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = previousRagApiUrl;
  });

  it('passes the knowledge-base entity scope to RAG document deletion', async () => {
    process.env.RAG_API_URL = 'http://rag.internal';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectors({ user: { id: 'user-1' } }, { file_id: 'file-1', embedded: true }, 'kb-1');

    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.internal/documents',
      expect.objectContaining({
        data: ['file-1'],
        params: { entity_id: 'kb-1' },
      }),
    );
  });
});
