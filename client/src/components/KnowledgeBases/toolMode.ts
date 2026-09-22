import type { TEphemeralAgent } from 'librechat-data-provider';

export function resolveKnowledgeBaseToolMode(
  ephemeralAgent: TEphemeralAgent | null | undefined,
  knowledgeBaseIds: string[] | undefined,
) {
  const hasKnowledgeBases = (knowledgeBaseIds?.length ?? 0) > 0;
  if (!hasKnowledgeBases) {
    return { ephemeralAgent, knowledgeBaseOnly: false };
  }

  const legacyFileSearchEnabled = ephemeralAgent?.file_search === true;
  return {
    ephemeralAgent: { ...(ephemeralAgent ?? {}), file_search: true },
    knowledgeBaseOnly: !legacyFileSearchEnabled,
  };
}
