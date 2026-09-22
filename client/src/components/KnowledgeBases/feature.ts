export type KnowledgeBasesFeatureConfig =
  | boolean
  | { use?: boolean; create?: boolean; share?: boolean; public?: boolean }
  | null
  | undefined;

export const isKnowledgeBasesEnabled = (config: KnowledgeBasesFeatureConfig) =>
  config != null && config !== false && !(typeof config === 'object' && config.use === false);

export const isKnowledgeBaseActionEnabled = (
  config: KnowledgeBasesFeatureConfig,
  action: 'create' | 'share' | 'public',
) =>
  isKnowledgeBasesEnabled(config) &&
  (config == null || typeof config !== 'object' || config[action] !== false);
