import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useHasAccess } from '~/hooks';
import { isKnowledgeBasesEnabled } from './feature';

export default function useKnowledgeBasesEnabled() {
  const { data } = useGetStartupConfig();
  const hasAccess = useHasAccess({
    permissionType: PermissionTypes.KNOWLEDGE_BASES,
    permission: Permissions.USE,
  });
  return hasAccess && isKnowledgeBasesEnabled(data?.interface?.knowledgeBases);
}
