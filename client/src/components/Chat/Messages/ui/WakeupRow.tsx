import { useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { WakeupTask } from '../Content/Parts/wakeup';
import {
  agentAuthor,
  isSelfSpawn,
  messageAuthor,
  findAgentAuthorMessage,
  useParentAuthor,
  readableSubagentType,
  readableSubagentTitle,
} from '~/components/Chat/Subagents/author';
import { useParentSubagents } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { useShareContext } from '~/Providers/ShareContext';
import { useAgentsMapContext } from '~/Providers';
import MessageRow from './MessageRow';
import { useLocalize } from '~/hooks';

/** Only wake-up rows observe the child index; ordinary rows keep their subscriptions. */
export default function WakeupRow({
  task,
  conversationId,
  ...props
}: ComponentProps<typeof MessageRow> & { task?: WakeupTask; conversationId: string }) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const { isSharedConvo } = useShareContext();
  const { getMessages } = useOptionalMessagesOperations();
  const { byThreadId } = useParentSubagents();
  const child = task?.threadId == null ? undefined : byThreadId.get(task.threadId);
  const parentMessageId = child?.parentMessageId ?? props.id ?? '';
  const fallbackName = localize('com_ui_subagent_actor');
  const privateParentAuthor = useParentAuthor(
    conversationId,
    isSharedConvo === true ? '' : parentMessageId,
    fallbackName,
  );
  const parentAuthor = useMemo(
    () =>
      isSharedConvo === true
        ? messageAuthor(
            findAgentAuthorMessage(getMessages(), parentMessageId),
            agentsMap,
            fallbackName,
          )
        : privateParentAuthor,
    [agentsMap, fallbackName, getMessages, isSharedConvo, parentMessageId, privateParentAuthor],
  );
  const author = useMemo(() => {
    const subagentType = child?.subagentType ?? task?.subagentType;
    if (isSelfSpawn(subagentType, child?.subagentKind)) return parentAuthor;
    const agent =
      child?.subagentKind === 'agent' && child.agentId != null
        ? agentsMap?.[child.agentId]
        : undefined;
    return agentAuthor(
      agent,
      readableSubagentTitle(child?.title, child?.agentId, child?.subagentKind) ??
        readableSubagentType(subagentType, child?.agentId, child?.subagentKind) ??
        localize('com_ui_subagent_actor'),
    );
  }, [agentsMap, child, localize, parentAuthor, task?.subagentType]);
  return (
    <MessageRow
      {...props}
      icon={author.icon}
      label={author.name}
      hoverLabel={undefined}
      headerPrefix={undefined}
      showAuthor
      outlined
    />
  );
}
