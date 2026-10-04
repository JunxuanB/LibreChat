import { useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { WakeupTask } from '../Content/Parts/wakeup';
import {
  agentAuthor,
  isSelfSpawn,
  messageAuthor,
  resolveSelfAuthor,
  findAgentAuthorMessage,
  useParentAuthor,
  readableSubagentType,
  readableSubagentTitle,
} from '~/components/Chat/Subagents/author';
import { useParentSubagents } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { findSubagentDispatch } from '~/components/Chat/Subagents/dispatch';
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
  const sharedDispatch = useMemo(
    () =>
      isSharedConvo === true ? findSubagentDispatch(getMessages(), task?.threadId) : undefined,
    [getMessages, isSharedConvo, task?.threadId],
  );
  const parentMessageId =
    child?.parentMessageId ?? sharedDispatch?.message.messageId ?? props.id ?? '';
  const fallbackName = localize('com_ui_subagent_actor');
  const privateParentAuthor = useParentAuthor(
    conversationId,
    isSharedConvo === true ? '' : parentMessageId,
    fallbackName,
    child?.parentToolCallId,
  );
  const parentAuthor = useMemo(
    () =>
      isSharedConvo === true
        ? messageAuthor(
            findAgentAuthorMessage(getMessages(), parentMessageId),
            agentsMap,
            fallbackName,
            sharedDispatch?.agentId,
          )
        : privateParentAuthor,
    [
      agentsMap,
      fallbackName,
      getMessages,
      isSharedConvo,
      parentMessageId,
      privateParentAuthor,
      sharedDispatch,
    ],
  );
  const author = useMemo(() => {
    const subagentType = child?.subagentType ?? sharedDispatch?.subagentType ?? task?.subagentType;
    const kind = child?.subagentKind ?? sharedDispatch?.identity?.subagentKind;
    const agentId = child?.agentId ?? sharedDispatch?.identity?.subagentAgentId;
    if (isSelfSpawn(subagentType, kind)) {
      return resolveSelfAuthor(parentAuthor, agentId, agentsMap, fallbackName);
    }
    const agent = kind === 'agent' ? agentsMap?.[agentId ?? ''] : undefined;
    return agentAuthor(
      agent,
      readableSubagentTitle(child?.title, child?.agentId, child?.subagentKind) ??
        readableSubagentType(subagentType, child?.agentId, kind) ??
        localize('com_ui_subagent_actor'),
    );
  }, [agentsMap, child, fallbackName, localize, parentAuthor, sharedDispatch, task?.subagentType]);
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
