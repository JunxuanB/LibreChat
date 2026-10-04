import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { isDocumentId } from '~/components/Chat/Messages/ui/HeaderLabel';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { useAgentsMapContext } from '~/Providers';

/** Who wrote a turn, in the form main chat's message header shows an author. */
export type TurnAuthor = { name: string; icon: ReactNode; agent?: Agent };

/** A subagent type worth showing on its own: a graph node's name, never an
 *  agent id — including `agentId`, the one the child's identity resolved to —
 *  or the `self` alias. */
export function readableSubagentType(
  subagentType?: string | null,
  agentId?: string,
  kind?: 'agent' | 'graph',
): string | undefined {
  if (subagentType == null || subagentType === '' || subagentType === 'self') return undefined;
  if (kind === 'graph') return subagentType;
  return isDocumentId(subagentType) || subagentType === agentId ? undefined : subagentType;
}

/** Stored display title, excluding legacy titles that contain storage keys. */
export function readableSubagentTitle(
  title: string | undefined,
  agentId?: string,
  kind?: 'agent' | 'graph',
): string | undefined {
  if (!title) return undefined;
  const name = title.startsWith('Subagent: ') ? title.slice('Subagent: '.length) : title;
  return readableSubagentType(name, agentId, kind);
}

/** The agent a child runs as: its own saved agent, or — for a self-spawn,
 *  which records none — the agent that spawned it. */
export function resolveChildAgent(
  agentId: string | undefined,
  subagentType: string | null | undefined,
  spawningAgent: Agent | undefined,
  agentsMap: Record<string, Agent | undefined> | undefined,
): Agent | undefined {
  if (agentId != null) return agentsMap?.[agentId];
  return subagentType === 'self' ? spawningAgent : undefined;
}

/** The author main chat draws for an agent turn: the agent's name and avatar,
 *  or the agents endpoint icon when it has none or is not resolvable. */
export function agentAuthor(agent: Agent | undefined, fallbackName: string): TurnAuthor {
  const name = agent?.name || fallbackName;
  return {
    agent,
    name,
    icon: (
      <MessageIcon
        iconData={{ endpoint: EModelEndpoint.agents, modelLabel: name, isCreatedByUser: false }}
        agent={agent}
      />
    ),
  };
}

type AuthorIndex = {
  byId: Map<string, TMessage>;
  byParentId: Map<string, TMessage>;
};

/** React Query replaces loaded message arrays. Weak keys let streamed snapshots
 *  be collected, while every wake-up in one snapshot shares a single pass. */
const authorIndexes = new WeakMap<TMessage[], AuthorIndex>();

/** The dispatching agent message, or the first agent reply to a user turn. */
export function findAgentAuthorMessage(
  messages: TMessage[] | undefined,
  messageId: string,
): TMessage | undefined {
  if (messages == null || messageId === '') return undefined;
  let index = authorIndexes.get(messages);
  if (index == null) {
    index = { byId: new Map(), byParentId: new Map() };
    for (const message of messages) {
      if (message.isCreatedByUser === true) continue;
      if (!index.byId.has(message.messageId)) index.byId.set(message.messageId, message);
      if (message.parentMessageId != null && !index.byParentId.has(message.parentMessageId)) {
        index.byParentId.set(message.parentMessageId, message);
      }
    }
    authorIndexes.set(messages, index);
  }
  return index.byId.get(messageId) ?? index.byParentId.get(messageId);
}

/** The author main chat's own header shows for `message`. */
export function messageAuthor(
  message: TMessage | undefined,
  agentsMap: Record<string, Agent | undefined> | undefined,
  fallbackName: string,
): TurnAuthor {
  if (message == null) return agentAuthor(undefined, fallbackName);
  const agent = message.model == null ? undefined : agentsMap?.[message.model];
  const name = agent?.name || message.sender || fallbackName;
  return {
    agent,
    name,
    icon: (
      <MessageIcon
        iconData={{
          endpoint: message.endpoint,
          model: message.model,
          iconURL: message.iconURL,
          modelLabel: name,
          isCreatedByUser: false,
        }}
        agent={agent}
      />
    ),
  };
}

/**
 * The agent that dispatched a child, read once from the parent conversation's
 * loaded messages — the dispatching message is on screen whenever its child can
 * be opened. Deliberately not a cache subscription: a running parent rewrites
 * that cache on every streamed chunk, and its author never changes with it.
 */
export function useParentAuthor(
  conversationId: string,
  messageId: string,
  fallbackName: string,
): TurnAuthor {
  const queryClient = useQueryClient();
  const agentsMap = useAgentsMapContext();
  const message = useMemo(
    () =>
      findAgentAuthorMessage(
        queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]),
        messageId,
      ),
    [conversationId, messageId, queryClient],
  );
  return useMemo(
    () => messageAuthor(message, agentsMap, fallbackName),
    [agentsMap, fallbackName, message],
  );
}
