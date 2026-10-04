import { EModelEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  isSelfSpawn,
  resolveChildAgent,
  readableSubagentType,
  findAgentAuthorMessage,
} from './author';

function message(
  messageId: string,
  parentMessageId: string | null,
  isCreatedByUser = false,
): TMessage {
  return {
    messageId,
    parentMessageId,
    isCreatedByUser,
    conversationId: 'parent',
    text: '',
    sender: messageId,
    endpoint: EModelEndpoint.agents,
  };
}

it('prefers the dispatch itself over an earlier reply and preserves the first agent reply', () => {
  const firstReply = message('first', 'dispatch');
  const dispatch = message('dispatch', null);
  const messages = [
    message('user', null, true),
    firstReply,
    dispatch,
    message('second', 'dispatch'),
  ];
  expect(findAgentAuthorMessage(messages, 'dispatch')).toBe(dispatch);
  expect(findAgentAuthorMessage(messages, 'missing')).toBeUndefined();
  expect(findAgentAuthorMessage([firstReply, message('second', 'dispatch')], 'dispatch')).toBe(
    firstReply,
  );
});

it('shares one history traversal across multiple wake-up authors and indexes a new snapshot', () => {
  const messages = Array.from({ length: 1000 }, (_, i) => message(`reply-${i}`, `wake-${i}`));
  const traversal = jest.spyOn(messages, Symbol.iterator);
  for (let i = 0; i < messages.length; i++) {
    expect(findAgentAuthorMessage(messages, `wake-${i}`)).toBe(messages[i]);
  }
  expect(traversal).toHaveBeenCalledTimes(1);
  const added = message('added', 'new-wake');
  expect(findAgentAuthorMessage([...messages, added], 'new-wake')).toBe(added);
  expect(findAgentAuthorMessage(messages, 'new-wake')).toBeUndefined();
});

it('preserves self as an explicit graph alias across author resolution', () => {
  expect(isSelfSpawn('self', 'graph')).toBe(false);
  expect(isSelfSpawn('self', 'agent')).toBe(true);
  expect(isSelfSpawn('self')).toBe(true);
  expect(readableSubagentType('self', undefined, 'graph')).toBe('self');
  expect(readableSubagentType('self')).toBeUndefined();
  expect(resolveChildAgent('agent-1', 'self', undefined, {}, 'graph')).toBeUndefined();
});
