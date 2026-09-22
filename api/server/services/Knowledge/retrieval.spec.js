jest.mock('~/models', () => ({ getKnowledgeDocuments: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({ findAccessibleResources: jest.fn() }));

const db = require('~/models');
const { findAccessibleResources } = require('~/server/services/PermissionService');
const { knowledgeRetrieval } = require('./retrieval');

describe('default knowledge retrieval dependencies', () => {
  it('intersects requested IDs with VIEW-authorized knowledge bases', async () => {
    findAccessibleResources.mockResolvedValue(['kb-1', 'kb-other']);
    await expect(
      knowledgeRetrieval.authorizeKnowledgeBases({
        knowledgeBaseIds: ['kb-1', 'kb-2'],
        userId: 'user-1',
        role: 'USER',
      }),
    ).resolves.toEqual(['kb-1']);
    expect(findAccessibleResources).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'knowledgeBase', requiredPermissions: 1 }),
    );
  });

  it('delegates ready-document lookup to the database boundary', async () => {
    db.getKnowledgeDocuments.mockResolvedValue([]);
    await knowledgeRetrieval.getKnowledgeDocuments({ knowledgeBaseIds: ['kb-1'] });
    expect(db.getKnowledgeDocuments).toHaveBeenCalledWith({ knowledgeBaseIds: ['kb-1'] });
  });
});
