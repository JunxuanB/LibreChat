import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import { getResourceConfig } from '../resources';

describe('knowledge base resource config', () => {
  it('resolves the roles required by the sharing dialog', () => {
    expect(getResourceConfig(ResourceType.KNOWLEDGE_BASE)).toMatchObject({
      resourceType: ResourceType.KNOWLEDGE_BASE,
      defaultViewerRoleId: AccessRoleIds.KNOWLEDGE_BASE_VIEWER,
      defaultEditorRoleId: AccessRoleIds.KNOWLEDGE_BASE_EDITOR,
      defaultOwnerRoleId: AccessRoleIds.KNOWLEDGE_BASE_OWNER,
    });
  });
});
