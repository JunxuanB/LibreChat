import { isKnowledgeConnectionInSourceScope } from './knowledgeBase';

const id = (value: string) => ({ toString: () => value });

describe('knowledge connection retrieval scope', () => {
  it('matches distinct owner and tenant identifier instances by value', () => {
    expect(
      isKnowledgeConnectionInSourceScope(
        { owner: id('owner-1'), tenantId: id('tenant-1') } as never,
        { owner: 'owner-1', tenantId: 'tenant-1' } as never,
      ),
    ).toBe(true);
  });

  it('rejects credentials from a different owner or tenant', () => {
    expect(
      isKnowledgeConnectionInSourceScope(
        { owner: id('owner-1'), tenantId: id('tenant-1') } as never,
        { owner: 'owner-2', tenantId: 'tenant-1' } as never,
      ),
    ).toBe(false);
    expect(
      isKnowledgeConnectionInSourceScope(
        { owner: id('owner-1'), tenantId: id('tenant-1') } as never,
        { owner: 'owner-1', tenantId: 'tenant-2' } as never,
      ),
    ).toBe(false);
  });
});
