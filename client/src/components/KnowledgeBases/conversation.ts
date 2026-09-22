import type { TConversation } from 'librechat-data-provider';

export type KnowledgeConversation = TConversation & { knowledge_base_ids?: string[] };

export const withKnowledgeBases = (current: TConversation | null, ids: string[]) =>
  current == null ? current : ({ ...current, knowledge_base_ids: ids } as KnowledgeConversation);
