export type KnowledgeBasesFeatureConfig =
  | boolean
  | { use?: boolean; create?: boolean; share?: boolean; public?: boolean }
  | null
  | undefined;

export const isKnowledgeBasesEnabled = (config: KnowledgeBasesFeatureConfig) =>
  config != null && config !== false && !(typeof config === 'object' && config.use === false);

