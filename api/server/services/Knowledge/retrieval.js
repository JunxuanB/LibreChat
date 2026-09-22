const { PermissionBits, ResourceType } = require('librechat-data-provider');
const db = require('~/models');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { queryExternalKnowledge } = require('./externalRetrieval');

const knowledgeRetrieval = {
  async authorizeKnowledgeBases({ knowledgeBaseIds, userId, role }) {
    const accessible = await findAccessibleResources({
      userId,
      role,
      resourceType: ResourceType.KNOWLEDGE_BASE,
      requiredPermissions: PermissionBits.VIEW,
    });
    const requested = new Set(knowledgeBaseIds);
    return accessible.map(String).filter((id) => requested.has(id));
  },
  getKnowledgeDocuments: db.getKnowledgeDocuments,
  queryExternalKnowledge,
};

module.exports = { knowledgeRetrieval };
