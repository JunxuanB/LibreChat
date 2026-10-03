import type { AnyBulkWriteOperation, Document } from 'mongodb';
import type { Connection } from 'mongoose';
import type { SearchTokenField } from '~/utils/search';
import {
  computeSearchTokenSet,
  USER_SEARCH_TOKEN_FIELDS,
  GROUP_SEARCH_TOKEN_FIELDS,
} from '~/utils/search';
import logger from '~/config/winston';

const DEFAULT_BATCH_SIZE = 500;

const SEARCH_TOKEN_COLLECTIONS: ReadonlyArray<{
  name: string;
  fields: readonly SearchTokenField[];
}> = [
  { name: 'users', fields: USER_SEARCH_TOKEN_FIELDS },
  { name: 'groups', fields: GROUP_SEARCH_TOKEN_FIELDS },
];

export interface SearchTokenBackfillResult {
  /** Documents missing at least one token field, per collection. */
  pending: Record<string, number>;
  /** Documents written, per collection; zero on a dry run. */
  updated: Record<string, number>;
}

/** Index-bound: each branch seeks one token index on its missing-key bounds. */
function missingTokens(fields: readonly SearchTokenField[]): Document {
  return { $or: fields.map((field) => ({ [field.tokens]: { $exists: false } })) };
}

/**
 * Writes the search-token arrays on users and groups saved before they existed.
 * Idempotent and resumable: only documents missing a token field are read, and
 * each write is guarded by the source values it was computed from, so a
 * concurrent rename (whose own update already wrote fresh tokens) is skipped.
 * Runs across all tenants on the raw collections; the `_id` filter keeps every
 * write on its own document, and `tenantId` is never written.
 */
export async function backfillSearchTokens(
  connection: Connection,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<SearchTokenBackfillResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const result: SearchTokenBackfillResult = { pending: {}, updated: {} };

  for (const { name, fields } of SEARCH_TOKEN_COLLECTIONS) {
    const collection = connection.db!.collection(name);
    const filter = missingTokens(fields);
    result.pending[name] = await collection.countDocuments(filter);
    result.updated[name] = 0;
    if (options.dryRun || result.pending[name] === 0) {
      continue;
    }

    const projection = Object.fromEntries(fields.map((field) => [field.source, 1]));
    let batch: AnyBulkWriteOperation[] = [];
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      // eslint-disable-next-line no-restricted-syntax -- offline all-tenant migration; `_id` filters keep each write on its own document
      const written = await collection.bulkWrite(batch, { ordered: false });
      result.updated[name] += written.modifiedCount;
      batch = [];
    };

    for await (const doc of collection.find(filter, { projection })) {
      const guard = Object.fromEntries(
        fields.map((field) => [field.source, doc[field.source] ?? null]),
      );
      batch.push({
        updateOne: {
          filter: { _id: doc._id, ...guard },
          update: { $set: computeSearchTokenSet(fields, doc) },
        },
      });
      if (batch.length >= batchSize) {
        await flush();
      }
    }
    await flush();
    logger.info(
      `[SearchTokenMigration] ${name}: ${result.updated[name]} of ${result.pending[name]} documents backfilled`,
    );
  }
  return result;
}

/**
 * Logs a startup warning when users or groups still lack search tokens. Those
 * documents stay findable through the slower unindexed fallback until
 * `npm run migrate:search-tokens` runs.
 */
export async function warnOnMissingSearchTokens(connection: Connection): Promise<number> {
  const { pending } = await backfillSearchTokens(connection, { dryRun: true });
  const total = Object.values(pending).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    logger.warn(
      `[SearchTokenMigration] ${total} users and groups lack search tokens; people search scans the collection for them until you run: npm run migrate:search-tokens`,
    );
  }
  return total;
}
