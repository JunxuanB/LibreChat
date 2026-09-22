export * from './types';
export * from './registry';
export * from './website';
export * from './customApi';
export * from './github';
export * from './googleDrive';
export * from './sharePoint';
export * from './notion';
export * from './confluence';
export * from './postgresql';
export * from './mcp';
export * from './externalIndex';

import { KnowledgeConnectorRegistry } from './registry';
import { customApiConnector } from './customApi';
import { websiteConnector } from './website';
import { githubConnector } from './github';
import { googleDriveConnector } from './googleDrive';
import { sharePointConnector } from './sharePoint';
import { notionConnector } from './notion';
import { confluenceConnector } from './confluence';
import { postgresqlConnector } from './postgresql';
import { mcpKnowledgeConnector } from './mcp';
import { externalIndexConnector } from './externalIndex';

export function createDefaultKnowledgeConnectorRegistry(): KnowledgeConnectorRegistry {
  return new KnowledgeConnectorRegistry()
    .register(websiteConnector)
    .register(githubConnector)
    .register(googleDriveConnector)
    .register(sharePointConnector)
    .register(notionConnector)
    .register(confluenceConnector)
    .register(postgresqlConnector)
    .register(customApiConnector)
    .register(mcpKnowledgeConnector)
    .register(externalIndexConnector);
}
