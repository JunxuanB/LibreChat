import { renderHook } from '@testing-library/react';
import useSideNavLinks from '../useSideNavLinks';

let mockKnowledgeAccess = true;

jest.mock(
  '@librechat/client',
  () => ({
    MCPIcon: () => null,
    AttachmentIcon: () => null,
    OpenAIMinimalIcon: () => null,
  }),
  { virtual: true },
);

jest.mock('~/hooks', () => ({
  useHasAccess: ({ permissionType }: { permissionType: unknown }) => {
    const { PermissionTypes: ActualPermissionTypes } =
      jest.requireActual('librechat-data-provider');
    return permissionType === ActualPermissionTypes.KNOWLEDGE_BASES ? mockKnowledgeAccess : false;
  },
  useMCPServerManager: () => ({ availableMCPServers: [] }),
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useAgentCapabilities: () => ({ skillsEnabled: false }),
}));

jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Schedules', () => ({ SchedulePanel: () => null }));
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/SidePanel/Files/Panel', () => () => null);
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));
jest.mock('~/components/KnowledgeBases/KnowledgeBasesAccordion', () => () => null);

const renderLinks = (knowledgeBases: unknown) =>
  renderHook(() =>
    useSideNavLinks({
      keyProvided: false,
      interfaceConfig: { knowledgeBases } as never,
      endpointsConfig: {} as never,
      includeHidePanel: false,
    }),
  ).result.current;

describe('knowledge base side navigation gate', () => {
  it('shows the library only when both feature and USE permission are enabled', () => {
    mockKnowledgeAccess = true;
    expect(renderLinks(true).map((link) => link.id)).toContain('knowledge-bases');
    expect(renderLinks(false).map((link) => link.id)).not.toContain('knowledge-bases');

    mockKnowledgeAccess = false;
    expect(renderLinks(true).map((link) => link.id)).not.toContain('knowledge-bases');
  });
});
