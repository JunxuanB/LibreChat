import type { TConversation } from 'librechat-data-provider';
import { withKnowledgeBases } from '~/components/KnowledgeBases/conversation';

describe('withKnowledgeBases', () => {
  it('adds selected ids without changing other conversation fields', () => {
    const conversation = {
      conversationId: 'new',
      endpoint: 'agents',
      title: 'New Chat',
      createdAt: '',
      updatedAt: '',
    } as TConversation;

    expect(withKnowledgeBases(conversation, ['kb-1'])).toMatchObject({
      conversationId: 'new',
      endpoint: 'agents',
      knowledge_base_ids: ['kb-1'],
    });
  });

  it('does not create a conversation while selection state is unavailable', () => {
    expect(withKnowledgeBases(null, ['kb-1'])).toBeNull();
  });
});
