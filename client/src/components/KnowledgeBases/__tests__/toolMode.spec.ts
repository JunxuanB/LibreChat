import { resolveKnowledgeBaseToolMode } from '../toolMode';

describe('resolveKnowledgeBaseToolMode', () => {
  it('exposes file search for selected knowledge bases without changing the legacy toggle', () => {
    expect(resolveKnowledgeBaseToolMode({ file_search: false }, ['kb-1'])).toEqual({
      ephemeralAgent: { file_search: true },
      knowledgeBaseOnly: true,
    });
  });

  it('does not expose file search with no knowledge bases and the legacy toggle off', () => {
    expect(resolveKnowledgeBaseToolMode({ file_search: false }, [])).toEqual({
      ephemeralAgent: { file_search: false },
      knowledgeBaseOnly: false,
    });
  });

  it('preserves legacy file search with no knowledge bases', () => {
    expect(resolveKnowledgeBaseToolMode({ file_search: true }, undefined)).toEqual({
      ephemeralAgent: { file_search: true },
      knowledgeBaseOnly: false,
    });
  });

  it('removes only KB-driven exposure after the last knowledge base is deselected', () => {
    const selected = resolveKnowledgeBaseToolMode({ file_search: false }, ['kb-1']);
    expect(selected.ephemeralAgent?.file_search).toBe(true);

    expect(resolveKnowledgeBaseToolMode({ file_search: false }, [])).toEqual({
      ephemeralAgent: { file_search: false },
      knowledgeBaseOnly: false,
    });
  });

  it('combines legacy file search and knowledge bases when both are enabled', () => {
    expect(resolveKnowledgeBaseToolMode({ file_search: true }, ['kb-1'])).toEqual({
      ephemeralAgent: { file_search: true },
      knowledgeBaseOnly: false,
    });
  });
});
