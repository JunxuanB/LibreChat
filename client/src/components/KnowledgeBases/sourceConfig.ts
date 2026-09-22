import type { KnowledgeConnectorField, KnowledgeSourceInput } from '~/data-provider';

export function partitionConnectorValues(
  fields: KnowledgeConnectorField[],
  values: Record<string, unknown>,
) {
  const config: Record<string, unknown> = {};
  const credentials: Record<string, string> = {};
  fields.forEach((field) => {
    const value = values[field.key];
    if (value === undefined || value === '') return;
    if (field.secret || field.type === 'password') credentials[field.key] = String(value);
    else if (field.type === 'string_array') {
      const entries = (Array.isArray(value) ? value : String(value).split(/[\n,]/))
        .map((entry) => String(entry).trim())
        .filter(Boolean);
      if (entries.length > 0) config[field.key] = entries;
    } else config[field.key] = value;
  });
  return { config, credentials };
}

export function buildKnowledgeSourceInput({
  type,
  name,
  fields,
  values,
}: {
  type: string;
  name: string;
  fields: KnowledgeConnectorField[];
  values: Record<string, unknown>;
}): KnowledgeSourceInput {
  const { config, credentials } = partitionConnectorValues(fields, values);
  return {
    type,
    name: name.trim(),
    config,
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}
