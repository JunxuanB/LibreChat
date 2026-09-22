import { createKnowledgeSourceHandlers } from './sources';

const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

describe('knowledge source handlers', () => {
  test('returns the injected connector manifest', async () => {
    const connector = {
      type: 'github' as const,
      name: 'GitHub',
      description: 'Repositories',
      category: 'apps',
      capabilities: ['sync'],
      fields: [],
    };
    const handlers = createKnowledgeSourceHandlers({
      connectorRegistry: { list: () => [connector] },
      listKnowledgeSources: jest.fn(),
      createKnowledgeSource: jest.fn(),
      updateKnowledgeSource: jest.fn(),
      deleteKnowledgeSource: jest.fn(),
    });
    const res = response();
    await handlers.connectors({} as never, res as never);
    expect(res.json).toHaveBeenCalledWith({ connectors: [connector] });
  });
});
