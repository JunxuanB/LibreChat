import { rankKnowledgeCandidates } from './ranking';

describe('knowledge candidate ranking', () => {
  test('combines semantic recall with BM25 exact-term relevance', () => {
    const ranked = rankKnowledgeCandidates({
      query: 'enterprise refund window',
      candidates: [
        { content: 'General billing overview', distance: 0.05, sourceKey: 'billing' },
        {
          content: 'The enterprise refund window is thirty days.',
          distance: 0.2,
          sourceKey: 'policy',
        },
      ],
    });

    expect(ranked[0].candidate.sourceKey).toBe('policy');
    expect(ranked[0].lexicalScore).toBeGreaterThan(0);
  });

  test('balances sources and respects the model-context content budget', () => {
    const ranked = rankKnowledgeCandidates({
      query: 'policy',
      candidates: [
        { content: 'policy one', distance: 0.01, sourceKey: 'source-a' },
        { content: 'policy two', distance: 0.02, sourceKey: 'source-a' },
        { content: 'policy three', distance: 0.03, sourceKey: 'source-b' },
      ],
      maxPerSource: 1,
      maxContentCharacters: 24,
    });

    expect(ranked.map((item) => item.candidate.sourceKey)).toEqual(['source-a', 'source-b']);
    expect(
      ranked.reduce((total, item) => total + item.candidate.content.length, 0),
    ).toBeLessThanOrEqual(24);
  });
});
