import { optionalString, requiredString } from './helpers';
import type { KnowledgeConnector, KnowledgeSourceChange } from './types';

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`${field} must be a PostgreSQL identifier`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function columns(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`${field} must contain at least one column`);
  }
  const normalized = (value as string[]).map((item) => item.trim());
  if (normalized.some((item) => item === '') || new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must contain unique, non-empty columns`);
  }
  return normalized;
}

interface PostgresCursor {
  id: string;
  updated?: string;
}

function parseCursor(
  value: string | undefined,
  requiresUpdated: boolean,
): PostgresCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<PostgresCursor>;
    if (
      typeof parsed.id !== 'string' ||
      parsed.id === '' ||
      (requiresUpdated && (typeof parsed.updated !== 'string' || parsed.updated === ''))
    ) {
      throw new Error('invalid shape');
    }
    return { id: parsed.id, updated: parsed.updated };
  } catch {
    throw new Error('PostgreSQL cursor is invalid');
  }
}

export const postgresqlConnector: KnowledgeConnector = {
  manifest: {
    type: 'postgresql',
    name: 'PostgreSQL',
    description: 'Index rows from an allowlisted table or view.',
    category: 'database',
    setup: 'manual_credentials',
    capabilities: ['incremental_sync'],
    fields: [
      {
        key: 'connectionString',
        label: 'Read-only connection string',
        type: 'password',
        secret: true,
        required: true,
      },
      { key: 'schema', label: 'Schema', type: 'text', placeholder: 'public' },
      { key: 'relation', label: 'Table or view', type: 'text', required: true },
      { key: 'idColumn', label: 'ID column', type: 'text', required: true },
      {
        key: 'titleColumn',
        label: 'Title column',
        type: 'text',
        required: true,
      },
      {
        key: 'contentColumns',
        label: 'Content columns',
        type: 'string_array',
        required: true,
      },
      { key: 'updatedColumn', label: 'Updated-at column', type: 'text' },
      {
        key: 'batchSize',
        label: 'Rows per sync',
        type: 'number',
        placeholder: '1000',
      },
    ],
  },

  async validate(request, context) {
    if (!context.executeReadOnlyQuery)
      throw new Error('PostgreSQL query execution is not configured');
    const connection = requiredString(request.credentials, 'connectionString');
    await context.executeReadOnlyQuery(connection, 'SELECT 1 AS connected', [], request.signal);
  },

  async sync(request, context) {
    if (!context.executeReadOnlyQuery)
      throw new Error('PostgreSQL query execution is not configured');
    const connection = requiredString(request.credentials, 'connectionString');
    const schema = identifier(optionalString(request.config, 'schema') ?? 'public', 'schema');
    const relation = identifier(requiredString(request.config, 'relation'), 'relation');
    const idColumnName = requiredString(request.config, 'idColumn');
    const titleColumnName = requiredString(request.config, 'titleColumn');
    const contentColumnNames = columns(request.config.contentColumns, 'contentColumns');
    const updatedColumnName = optionalString(request.config, 'updatedColumn');
    const selectedColumnNames = Array.from(
      new Set(
        [idColumnName, titleColumnName, ...contentColumnNames, updatedColumnName].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    );
    const selected = selectedColumnNames.map((value) => identifier(value, 'column'));
    const values: unknown[] = [];
    let where = '';
    const cursor = parseCursor(
      !updatedColumnName && !request.continuation ? undefined : request.cursor,
      Boolean(updatedColumnName),
    );
    if (cursor && updatedColumnName) {
      values.push(cursor.updated, cursor.id);
      where = ` WHERE (${identifier(updatedColumnName, 'updatedColumn')} > $1 OR (${identifier(
        updatedColumnName,
        'updatedColumn',
      )} = $1 AND ${identifier(idColumnName, 'idColumn')} > $2))`;
    } else if (cursor) {
      values.push(cursor.id);
      where = ` WHERE ${identifier(idColumnName, 'idColumn')} > $1`;
    }
    const configuredBatchSize = Number(request.config.batchSize ?? 1000);
    const batchSize = Number.isInteger(configuredBatchSize)
      ? Math.max(1, Math.min(10_000, configuredBatchSize))
      : 1000;
    const order = updatedColumnName
      ? `${identifier(updatedColumnName, 'updatedColumn')} ASC, ${identifier(
          idColumnName,
          'idColumn',
        )} ASC`
      : `${identifier(idColumnName, 'idColumn')} ASC`;
    const sql = `SELECT ${selected.join(', ')} FROM ${schema}.${relation}${where} ORDER BY ${order} LIMIT ${batchSize}`;
    const rows = await context.executeReadOnlyQuery(connection, sql, values, request.signal);
    const changes: KnowledgeSourceChange[] = rows.map((row) => {
      if (row[idColumnName] == null) throw new Error('PostgreSQL ID column contains null');
      if (updatedColumnName && row[updatedColumnName] == null) {
        throw new Error('PostgreSQL updated-at column contains null');
      }
      return {
        operation: 'upsert',
        item: {
          externalId: String(row[idColumnName]),
          title: String(row[titleColumnName] ?? row[idColumnName]),
          content: contentColumnNames
            .map((column) => `${column}: ${String(row[column] ?? '')}`)
            .join('\n'),
          mimeType: 'text/plain',
          revision: updatedColumnName ? String(row[updatedColumnName] ?? '') : undefined,
          updatedAt: updatedColumnName ? String(row[updatedColumnName] ?? '') : undefined,
          metadata: Object.fromEntries(
            Object.entries(row).filter(([key]) => !contentColumnNames.includes(key)),
          ),
        },
      };
    });
    const lastRow = rows[rows.length - 1];
    const hasMore = rows.length === batchSize;
    const nextCursor =
      lastRow && (hasMore || updatedColumnName)
        ? JSON.stringify({
            id: String(lastRow[idColumnName]),
            ...(updatedColumnName ? { updated: String(lastRow[updatedColumnName] ?? '') } : {}),
          })
        : updatedColumnName
          ? request.cursor
          : '';
    return {
      changes,
      cursor: nextCursor,
      complete: !hasMore,
      snapshot: !updatedColumnName,
    };
  },
};
