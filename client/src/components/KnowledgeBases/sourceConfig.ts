import type { KnowledgeConnectorField } from '~/data-provider';

export function partitionConnectorValues(
  fields: KnowledgeConnectorField[],
  values: Record<string, unknown>,
) {
  const config: Record<string, unknown> = {};
  const credentials: Record<string, string> = {};
  fields.forEach((field) => {
    const value = values[field.key];
    if (value === undefined || value === '') return;
    if (field.secret) credentials[field.key] = String(value);
    else config[field.key] = value;
  });
  return { config, credentials };
}
