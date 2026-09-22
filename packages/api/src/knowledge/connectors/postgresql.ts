import { optionalString, requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`${field} must be a PostgreSQL identifier`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function columns(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must contain at least one column`);
  }
  return value as string[];
}

export const postgresqlConnector: KnowledgeConnector = {
  manifest: {
    type: 'postgresql',
    name: 'PostgreSQL',
    description: 'Index rows from an allowlisted table or view.',
    category: 'database',
    capabilities: ['incremental_sync', 'live_query'],
    fields: [
      { key: 'connectionString', label: 'Read-only connection string', type: 'password', secret: true, required: true },
      { key: 'schema', label: 'Schema', type: 'text', placeholder: 'public' },
      { key: 'relation', label: 'Table or view', type: 'text', required: true },
      { key: 'idColumn', label: 'ID column', type: 'text', required: true },
      { key: 'titleColumn', label: 'Title column', type: 'text', required: true },
      { key: 'updatedColumn', label: 'Updated-at column', type: 'text' },
    ],
  },

  async validate(request, context) {
    if (!context.executeReadOnlyQuery) throw new Error('PostgreSQL query execution is not configured');
    const connection = requiredString(request.credentials, 'connectionString');
    await context.executeReadOnlyQuery(connection, 'SELECT 1 AS connected', [], request.signal);
  },

  async sync(request, context) {
    if (!context.executeReadOnlyQuery) throw new Error('PostgreSQL query execution is not configured');
    const connection = requiredString(request.credentials, 'connectionString');
    const schema = identifier(optionalString(request.config, 'schema') ?? 'public', 'schema');
    const relation = identifier(requiredString(request.config, 'relation'), 'relation');
    const idColumnName = requiredString(request.config, 'idColumn');
    const titleColumnName = requiredString(request.config, 'titleColumn');
    const contentColumnNames = columns(request.config.contentColumns, 'contentColumns');
    const updatedColumnName = optionalString(request.config, 'updatedColumn');
    const selected = [idColumnName, titleColumnName, ...contentColumnNames, updatedColumnName]
      .filter((value): value is string => Boolean(value))
      .map((value) => identifier(value, 'column'));
    const values: unknown[] = [];
    let where = '';
    if (request.cursor && updatedColumnName) {
      values.push(request.cursor);
      where = ` WHERE ${identifier(updatedColumnName, 'updatedColumn')} > $1`;
    }
    const sql = `SELECT ${selected.join(', ')} FROM ${schema}.${relation}${where} ORDER BY ${
      updatedColumnName ? identifier(updatedColumnName, 'updatedColumn') : identifier(idColumnName, 'idColumn')
    } ASC LIMIT 10000`;
    const rows = await context.executeReadOnlyQuery(connection, sql, values, request.signal);
    const changes: KnowledgeSourceChange[] = rows.map((row) => ({
      operation: 'upsert',
      item: {
        externalId: String(row[idColumnName]),
        title: String(row[titleColumnName]),
        content: contentColumnNames.map((column) => `${column}: ${String(row[column] ?? '')}`).join('\n'),
        mimeType: 'text/plain',
        revision: updatedColumnName ? String(row[updatedColumnName] ?? '') : undefined,
        updatedAt: updatedColumnName ? String(row[updatedColumnName] ?? '') : undefined,
        metadata: Object.fromEntries(
          Object.entries(row).filter(([key]) => !contentColumnNames.includes(key)),
        ),
      },
    }));
    const cursor = updatedColumnName
      ? rows.reduce<string | undefined>((latest, row) => {
          const value = String(row[updatedColumnName] ?? '');
          return !latest || value > latest ? value : latest;
        }, request.cursor)
      : request.cursor;
    return { changes, cursor };
  },
};
