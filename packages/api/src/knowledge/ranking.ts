export interface KnowledgeRankingCandidate {
  content: string;
  distance: number;
  sourceKey: string;
}

export interface RankedKnowledgeCandidate<T extends KnowledgeRankingCandidate> {
  candidate: T;
  score: number;
  semanticScore: number;
  lexicalScore: number;
}

const tokenize = (value: string): string[] =>
  value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.filter((token) => token.length > 1) ?? [];

/**
 * Reranks the bounded candidate set returned by vector/live providers. This is
 * intentionally provider-neutral: semantic distance supplies recall while
 * BM25 restores exact-term relevance before results enter model context.
 */
export function rankKnowledgeCandidates<T extends KnowledgeRankingCandidate>({
  query,
  candidates,
  limit = 10,
  maxPerSource = 4,
  maxContentCharacters = 24_000,
}: {
  query: string;
  candidates: readonly T[];
  limit?: number;
  maxPerSource?: number;
  maxContentCharacters?: number;
}): Array<RankedKnowledgeCandidate<T>> {
  if (candidates.length === 0 || limit <= 0 || maxContentCharacters <= 0) return [];
  const queryTerms = tokenize(query);
  const documents = candidates.map((candidate) => tokenize(candidate.content));
  const averageLength =
    documents.reduce((total, document) => total + document.length, 0) /
    Math.max(documents.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
      if (queryTerms.includes(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }
  const lexicalScores = documents.map((document) => {
    if (queryTerms.length === 0 || document.length === 0) return 0;
    const frequencies = new Map<string, number>();
    for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return queryTerms.reduce((score, term) => {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) return score;
      const frequencyInDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (candidates.length - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5),
      );
      const denominator =
        frequency + 1.2 * (1 - 0.75 + 0.75 * (document.length / Math.max(averageLength, 1)));
      return score + inverseDocumentFrequency * ((frequency * 2.2) / denominator);
    }, 0);
  });
  const maximumLexicalScore = Math.max(...lexicalScores, 0);
  const ranked = candidates
    .map((candidate, index) => {
      const semanticScore = 1 / (1 + Math.max(0, candidate.distance));
      const lexicalScore = maximumLexicalScore > 0 ? lexicalScores[index] / maximumLexicalScore : 0;
      return {
        candidate,
        semanticScore,
        lexicalScore,
        score: semanticScore * 0.7 + lexicalScore * 0.3,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected: Array<RankedKnowledgeCandidate<T>> = [];
  const sourceCounts = new Map<string, number>();
  let usedCharacters = 0;
  const select = (item: RankedKnowledgeCandidate<T>, enforceSourceLimit: boolean) => {
    if (selected.includes(item) || selected.length >= limit) return;
    const sourceCount = sourceCounts.get(item.candidate.sourceKey) ?? 0;
    if (enforceSourceLimit && sourceCount >= maxPerSource) return;
    if (usedCharacters + item.candidate.content.length > maxContentCharacters) return;
    selected.push(item);
    sourceCounts.set(item.candidate.sourceKey, sourceCount + 1);
    usedCharacters += item.candidate.content.length;
  };
  for (const item of ranked) select(item, true);
  for (const item of ranked) select(item, false);
  return selected;
}
