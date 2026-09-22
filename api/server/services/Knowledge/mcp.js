const {
  cleanupMCPRequestContext,
  createMCPRequestContext,
  getMissingCustomUserVars,
  getMissingRuntimeBodyPlaceholderFields,
  getServerCustomUserVars,
  getUserMCPAuthMap,
  isDirectOpenIDBearerRecoveryEnabled,
  mcpOptionsContainGraphTokenPlaceholder,
} = require('@librechat/api');
const { tenantStorage } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPServersRegistry, getFlowStateManager, getMCPManager } = require('~/config');
const { getLogStores } = require('~/cache');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { userCanUseMCPServers } = require('~/server/services/MCP');

const BACKGROUND_AUTH_ERROR =
  'MCP server requires interactive or request-scoped authentication and cannot run in a background knowledge sync';

/**
 * Creates a resource caller bound to the persisted source owner. Dependencies
 * are injectable so this security boundary can be tested without a live MCP server.
 */
function createKnowledgeMcpCaller(overrides = {}) {
  const database = overrides.db ?? db;
  const loadAppConfig = overrides.getAppConfig ?? getAppConfig;
  const getRegistry = overrides.getMCPServersRegistry ?? getMCPServersRegistry;
  const getManager = overrides.getMCPManager ?? getMCPManager;
  const canUseMcp = overrides.userCanUseMCPServers ?? userCanUseMCPServers;
  const createContext = overrides.createMCPRequestContext ?? createMCPRequestContext;
  const cleanupContext = overrides.cleanupMCPRequestContext ?? cleanupMCPRequestContext;
  const createFlowManager =
    overrides.getFlowStateManager ?? (() => getFlowStateManager(getLogStores(CacheKeys.FLOWS)));
  const tenantContext = overrides.tenantStorage ?? tenantStorage;

  return async function callKnowledgeMcp(source, serverName, method, params = {}, signal) {
    if (!source?.ownerId) throw new Error('Knowledge source owner is unavailable');
    const ownerId = String(source.ownerId);
    const sourceTenant = source.tenantId == null ? undefined : String(source.tenantId);
    return tenantContext.run({ tenantId: sourceTenant, userId: ownerId }, async () => {
      signal?.throwIfAborted();
      const ownerRecord = await database.getUserById(ownerId);
      if (!ownerRecord) throw new Error('Knowledge source owner no longer exists');
      const owner = { ...ownerRecord, id: ownerId };
      const ownerTenant = owner.tenantId == null ? undefined : String(owner.tenantId);
      if (sourceTenant !== ownerTenant) {
        throw new Error('Knowledge source owner tenant no longer matches the source');
      }
      if (!(await canUseMcp(owner))) {
        throw new Error('Knowledge source owner is not permitted to use MCP servers');
      }

      const appConfig = await loadAppConfig({
        role: owner.role,
        tenantId: sourceTenant,
        userId: ownerId,
        idOnTheSource: owner.idOnTheSource ?? undefined,
        failClosed: true,
      });
      const registry = getRegistry();
      const configServers = await registry.ensureConfigServers(appConfig?.mcpConfig ?? {});
      const accessibleServers = await registry.getAllServerConfigs(
        ownerId,
        configServers,
        owner.role,
      );
      const serverConfig = accessibleServers[serverName];
      if (!serverConfig) {
        throw new Error(`MCP server "${serverName}" is unavailable to the knowledge source owner`);
      }

      if (serverConfig.obo != null || isDirectOpenIDBearerRecoveryEnabled(serverConfig)) {
        throw new Error(BACKGROUND_AUTH_ERROR);
      }
      if (getMissingRuntimeBodyPlaceholderFields(serverConfig).length > 0) {
        throw new Error(`${BACKGROUND_AUTH_ERROR}: request BODY placeholders are not supported`);
      }
      if (mcpOptionsContainGraphTokenPlaceholder(serverConfig)) {
        throw new Error(
          `${BACKGROUND_AUTH_ERROR}: Microsoft Graph token placeholders are not supported`,
        );
      }

      const authMap = await getUserMCPAuthMap({
        userId: ownerId,
        servers: [serverName],
        findPluginAuthsByKeys: database.findPluginAuthsByKeys,
      });
      const customUserVars = getServerCustomUserVars(authMap, serverName);
      const missingVars = getMissingCustomUserVars(serverConfig, customUserVars);
      if (missingVars.length > 0) {
        throw new Error(`MCP server "${serverName}" is missing saved user configuration`);
      }

      const requestContext = createContext();
      try {
        const manager = getManager(ownerId);
        return await manager.withUserConnectionLease(
          {
            user: owner,
            serverName,
            serverConfig,
            customUserVars,
            requestScopedConnections: requestContext,
            flowManager: createFlowManager(),
            tokenMethods: {
              findToken: database.findToken,
              createToken: database.createToken,
              updateToken: database.updateToken,
              deleteTokens: database.deleteTokens,
            },
            returnOnOAuth: true,
            oauthStart: async () => {
              throw new Error(BACKGROUND_AUTH_ERROR);
            },
            signal,
          },
          async (connection) => {
            signal?.throwIfAborted();
            if (method === 'resources/list') {
              const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
              return connection.listResources(cursor, signal);
            }
            if (method === 'resources/read') {
              if (typeof params.uri !== 'string' || params.uri.length === 0) {
                throw new Error('MCP resource URI is required');
              }
              return connection.readResource(params.uri, signal);
            }
            throw new Error(`Unsupported MCP resource method: ${method}`);
          },
        );
      } finally {
        await cleanupContext(requestContext);
      }
    });
  };
}

const callKnowledgeMcp = createKnowledgeMcpCaller();

module.exports = {
  BACKGROUND_AUTH_ERROR,
  createKnowledgeMcpCaller,
  callKnowledgeMcp,
};
