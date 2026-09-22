import { MCPConnection } from '../connection';

function connectionWithClient(client: object): MCPConnection {
  const connection = Object.create(MCPConnection.prototype) as MCPConnection;
  connection.client = client as MCPConnection['client'];
  return connection;
}

describe('MCPConnection resource calls', () => {
  test('forwards cursors and cancellation to resources/list', async () => {
    const signal = new AbortController().signal;
    const listResources = jest.fn(async () => ({ resources: [], nextCursor: 'next' }));
    const connection = connectionWithClient({ listResources });

    await expect(connection.listResources('cursor-1', signal)).resolves.toEqual({
      resources: [],
      nextCursor: 'next',
    });
    expect(listResources).toHaveBeenCalledWith({ cursor: 'cursor-1' }, { signal });
  });

  test('forwards the URI and preserves resources/read failures', async () => {
    const readResource = jest.fn(async () => {
      throw new Error('read rejected');
    });
    const connection = connectionWithClient({ readResource });

    await expect(connection.readResource('kb://document')).rejects.toThrow('read rejected');
    expect(readResource).toHaveBeenCalledWith({ uri: 'kb://document' }, undefined);
  });
});
