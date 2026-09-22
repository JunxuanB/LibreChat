const { isIP } = require('node:net');
const { lookup: dnsLookup } = require('node:dns/promises');
const { Client: PostgresClient } = require('pg');
const PostgresCursor = require('pg-cursor');
const { isAddressAllowed, isPrivateIP, isSSRFTarget } = require('@librechat/api');

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const boundedInteger = (value, fallback, min, max) =>
  Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback;

function parseConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('PostgreSQL connection string must be a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL connection string must use postgres or postgresql');
  }
  if (!url.hostname || !url.username || url.pathname.length <= 1) {
    throw new Error('PostgreSQL connection string requires host, user, and database');
  }
  if (url.hash) {
    throw new Error('PostgreSQL connection string must not contain a fragment');
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'application_name') {
      throw new Error(`PostgreSQL connection option is managed by LibreChat: ${key}`);
    }
  }
  const port = url.port || '5432';
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new Error('PostgreSQL connection string has an invalid port');
  }
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    portNumber,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    applicationName: url.searchParams.get('application_name') || 'librechat-knowledge-sync',
  };
}

async function resolveSafeHost(target, allowedAddresses, lookup) {
  if (isSSRFTarget(target.hostname, allowedAddresses, target.port)) {
    throw new Error('PostgreSQL target is a restricted address');
  }

  let addresses;
  try {
    addresses = await lookup(target.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('PostgreSQL hostname could not be resolved');
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('PostgreSQL hostname did not resolve to an address');
  }

  const hostnameAllowed = isAddressAllowed(target.hostname, allowedAddresses, target.port);
  for (const entry of addresses) {
    if (
      isPrivateIP(entry.address) &&
      !hostnameAllowed &&
      !isAddressAllowed(entry.address, allowedAddresses, target.port)
    ) {
      throw new Error('PostgreSQL hostname resolves to a restricted address');
    }
  }
  return addresses[0].address;
}

function serializedBytes(value) {
  return Buffer.byteLength(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    'utf8',
  );
}

/**
 * Builds the host-injected `KnowledgeConnectorContext.executeReadOnlyQuery` implementation.
 *
 * Wiring: `connectorContext.executeReadOnlyQuery = createReadOnlyPostgresExecutor(policy)`.
 * Policy must come from deployment configuration, never from a knowledge source.
 * @param {object} [options]
 * @returns {import('@librechat/api').KnowledgeConnectorContext['executeReadOnlyQuery']}
 */
function createReadOnlyPostgresExecutor(options = {}) {
  const Client = options.Client || PostgresClient;
  const Cursor = options.Cursor || PostgresCursor;
  const lookup = options.lookup || dnsLookup;
  const allowedAddresses = options.allowedAddresses;
  const allowPlaintext = options.allowPlaintext === true;
  const connectionTimeoutMs = boundedInteger(
    options.connectionTimeoutMs,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    100,
    60_000,
  );
  const statementTimeoutMs = boundedInteger(
    options.statementTimeoutMs,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    100,
    120_000,
  );
  const maxRows = boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 10_000);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1_024, 20 * 1024 * 1024);

  return async function executeReadOnlyQuery(connectionString, text, values, signal) {
    if (typeof text !== 'string' || !/^\s*(?:select|with)\b/i.test(text)) {
      throw new Error('PostgreSQL knowledge connectors may only execute SELECT queries');
    }
    signal?.throwIfAborted();
    const target = parseConnectionString(connectionString);
    const address = await resolveSafeHost(target, allowedAddresses, lookup);
    signal?.throwIfAborted();

    const ssl = allowPlaintext
      ? false
      : {
          rejectUnauthorized: true,
          ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        };
    const client = new Client({
      host: address,
      port: target.portNumber,
      user: target.user,
      password: target.password,
      database: target.database,
      application_name: target.applicationName,
      connectionTimeoutMillis: connectionTimeoutMs,
      query_timeout: statementTimeoutMs + 1_000,
      ssl,
    });

    let began = false;
    let ended = false;
    const end = async () => {
      if (ended) return;
      ended = true;
      await client.end();
    };
    const abort = () => void end().catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      signal?.throwIfAborted();
      await client.query('BEGIN READ ONLY');
      began = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const cursor = client.query(new Cursor(text, Array.isArray(values) ? values : []));
      const rows = [];
      let bytes = 2;
      try {
        while (true) {
          signal?.throwIfAborted();
          const batch = await cursor.read(Math.min(100, maxRows + 1 - rows.length));
          if (!Array.isArray(batch) || batch.length === 0) break;
          for (const row of batch) {
            if (rows.length >= maxRows) {
              throw new Error(`PostgreSQL connector result exceeds the ${maxRows} row limit`);
            }
            bytes += serializedBytes(row) + (rows.length > 0 ? 1 : 0);
            if (bytes > maxBytes) {
              throw new Error(`PostgreSQL connector result exceeds the ${maxBytes} byte limit`);
            }
            rows.push(row);
          }
        }
      } finally {
        await cursor.close().catch(() => undefined);
      }
      await client.query('COMMIT');
      began = false;
      return rows;
    } catch (error) {
      if (began && !ended) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await end().catch(() => undefined);
    }
  };
}

module.exports = {
  createReadOnlyPostgresExecutor,
  parseConnectionString,
};
