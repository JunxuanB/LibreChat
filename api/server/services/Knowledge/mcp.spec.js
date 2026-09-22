jest.mock('~/models', () => ({}));
jest.mock('~/config', () => ({}));
jest.mock('~/cache', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/services/MCP', () => ({}));

const { BACKGROUND_AUTH_ERROR, createKnowledgeMcpCaller } = require('./mcp');

function build({ source = {}, user = {}, serverConfig = {}, tenantStorage } = {}) {
  const persistedSource = {
    ownerId: 'owner-1',
    tenantId: 'tenant-1',
    ...source,
  };
  const persistedUser = {
    _id: 'owner-1',
    role: 'USER',
    tenantId: 'tenant-1',
    ...user,
  };
  const connection = {
    listResources: jest.fn(async (cursor) => ({ resources: [], nextCursor: cursor })),
    readResource: jest.fn(async (uri) => ({ contents: [{ uri, text: 'hello' }] })),
  };
  const manager = {
    withUserConnectionLease: jest.fn(async (options, operation) => operation(connection)),
  };
  const registry = {
    ensureConfigServers: jest.fn(async (config) => config),
    getAllServerConfigs: jest.fn(async () => ({
      docs: { type: 'streamable-http', url: 'https://mcp.example.test', ...serverConfig },
    })),
  };
  const requestContext = { connections: new Map(), pending: new Map() };
  const cleanupMCPRequestContext = jest.fn(async () => undefined);
  const database = {
    getUserById: jest.fn(async () => persistedUser),
    findPluginAuthsByKeys: jest.fn(async () => []),
    findToken: jest.fn(),
    createToken: jest.fn(),
    updateToken: jest.fn(),
    deleteTokens: jest.fn(),
  };
  const getAppConfig = jest.fn(async () => ({
    mcpConfig: { docs: { type: 'streamable-http', url: 'https://mcp.example.test' } },
  }));
  const userCanUseMCPServers = jest.fn(async () => true);
  const scopedTenantStorage = tenantStorage ?? {
    run: jest.fn(async (_context, operation) => operation()),
  };
  const caller = createKnowledgeMcpCaller({
    db: database,
    getAppConfig,
    getMCPServersRegistry: () => registry,
    getMCPManager: () => manager,
    userCanUseMCPServers,
    createMCPRequestContext: () => requestContext,
    cleanupMCPRequestContext,
    getFlowStateManager: () => ({ flow: true }),
    tenantStorage: scopedTenantStorage,
  });
  return {
    caller,
    persistedSource,
    database,
    getAppConfig,
    userCanUseMCPServers,
    registry,
    manager,
    connection,
    requestContext,
    cleanupMCPRequestContext,
    tenantStorage: scopedTenantStorage,
  };
}

describe('knowledge MCP resource runtime', () => {
  it('rebuilds tenant config and leases a connection as the persisted source owner', async () => {
    const harness = build();

    await harness.caller(harness.persistedSource, 'docs', 'resources/list', { cursor: 'page-2' });

    expect(harness.database.getUserById).toHaveBeenCalledWith('owner-1');
    expect(harness.tenantStorage.run).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'owner-1' },
      expect.any(Function),
    );
    expect(harness.userCanUseMCPServers).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owner-1', tenantId: 'tenant-1' }),
    );
    expect(harness.getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1', tenantId: 'tenant-1', failClosed: true }),
    );
    expect(harness.registry.getAllServerConfigs).toHaveBeenCalledWith(
      'owner-1',
      expect.any(Object),
      'USER',
    );
    expect(harness.manager.withUserConnectionLease).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'owner-1' }),
        serverName: 'docs',
        requestScopedConnections: harness.requestContext,
        tokenMethods: expect.objectContaining({
          findToken: harness.database.findToken,
          createToken: harness.database.createToken,
        }),
      }),
      expect.any(Function),
    );
    expect(harness.database.findPluginAuthsByKeys).toHaveBeenCalledWith({
      userId: 'owner-1',
      pluginKeys: ['mcp_docs'],
    });
    expect(harness.connection.listResources).toHaveBeenCalledWith('page-2', undefined);
    expect(harness.cleanupMCPRequestContext).toHaveBeenCalledWith(harness.requestContext);
  });

  it('rechecks MCP USE permission before resolving server configuration', async () => {
    const harness = build();
    harness.userCanUseMCPServers.mockResolvedValue(false);

    await expect(
      harness.caller(harness.persistedSource, 'docs', 'resources/list', {}),
    ).rejects.toThrow('owner is not permitted');
    expect(harness.getAppConfig).not.toHaveBeenCalled();
    expect(harness.manager.withUserConnectionLease).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted owner has moved tenants', async () => {
    const harness = build({ user: { tenantId: 'tenant-2' } });

    await expect(
      harness.caller(harness.persistedSource, 'docs', 'resources/list', {}),
    ).rejects.toThrow('tenant no longer matches');
    expect(harness.userCanUseMCPServers).not.toHaveBeenCalled();
  });

  it('overrides a foreign ambient tenant for owner, auth, config, and connection work', async () => {
    let ambientTenant = 'triggering-editor-tenant';
    const observedTenants = [];
    const scopedTenantStorage = {
      run: jest.fn(async (context, operation) => {
        const previous = ambientTenant;
        ambientTenant = context.tenantId;
        try {
          return await operation();
        } finally {
          ambientTenant = previous;
        }
      }),
    };
    const harness = build({ tenantStorage: scopedTenantStorage });
    harness.database.getUserById.mockImplementation(async () => {
      observedTenants.push(ambientTenant);
      return { _id: 'owner-1', role: 'USER', tenantId: 'tenant-1' };
    });
    harness.database.findPluginAuthsByKeys.mockImplementation(async () => {
      observedTenants.push(ambientTenant);
      return [];
    });
    harness.getAppConfig.mockImplementation(async () => {
      observedTenants.push(ambientTenant);
      return { mcpConfig: {} };
    });
    harness.manager.withUserConnectionLease.mockImplementation(async (_options, operation) => {
      observedTenants.push(ambientTenant);
      return operation(harness.connection);
    });

    await harness.caller(harness.persistedSource, 'docs', 'resources/list', {});

    expect(observedTenants).toEqual(['tenant-1', 'tenant-1', 'tenant-1', 'tenant-1']);
    expect(ambientTenant).toBe('triggering-editor-tenant');
  });

  it.each([
    [{ obo: { scopes: ['api://example/.default'] } }, BACKGROUND_AUTH_ERROR],
    [
      { url: 'https://mcp.example.test/{{LIBRECHAT_BODY_MESSAGEID}}' },
      'BODY placeholders are not supported',
    ],
    [
      { headers: { Authorization: 'Bearer {{LIBRECHAT_GRAPH_ACCESS_TOKEN}}' } },
      'Graph token placeholders are not supported',
    ],
    [
      {
        source: 'config',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      },
      BACKGROUND_AUTH_ERROR,
    ],
  ])('rejects background-incompatible configuration %#', async (serverConfig, message) => {
    const harness = build({ serverConfig });

    await expect(
      harness.caller(harness.persistedSource, 'docs', 'resources/list', {}),
    ).rejects.toThrow(message);
    expect(harness.manager.withUserConnectionLease).not.toHaveBeenCalled();
  });

  it('uses the throwing read method and always cleans ephemeral request state', async () => {
    const harness = build();
    harness.connection.readResource.mockRejectedValue(new Error('MCP read failed'));

    await expect(
      harness.caller(harness.persistedSource, 'docs', 'resources/read', { uri: 'kb://doc' }),
    ).rejects.toThrow('MCP read failed');
    expect(harness.connection.readResource).toHaveBeenCalledWith('kb://doc', undefined);
    expect(harness.cleanupMCPRequestContext).toHaveBeenCalledWith(harness.requestContext);
  });
});
