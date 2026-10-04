import { useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { WakeupTask } from '../Content/Parts/wakeup';
import {
  agentAuthor,
  useParentAuthor,
  readableSubagentType,
  readableSubagentTitle,
} from '~/components/Chat/Subagents/author';
import { useParentSubagents } from '~/components/Chat/Subagents/ParentSubagentsProvider';
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
  const { byThreadId } = useParentSubagents();
  const child = task?.threadId == null ? undefined : byThreadId.get(task.threadId);
  const parentAuthor = useParentAuthor(
    conversationId,
    child?.parentMessageId ?? '',
    localize('com_ui_subagent_actor'),
  );
  const author = useMemo(() => {
    const subagentType = child?.subagentType ?? task?.subagentType;
    if (subagentType === 'self' && child?.subagentKind !== 'graph') return parentAuthor;
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
