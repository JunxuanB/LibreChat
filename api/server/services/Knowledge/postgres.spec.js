jest.mock(
  '@librechat/api',
  () => {
    const isPrivateIP = (address) =>
      address === '127.0.0.1' ||
      address.startsWith('10.') ||
      address.startsWith('192.168.') ||
      address === '::1';
    const isAddressAllowed = (address, allowed, port) =>
      (allowed ?? []).includes(`${address}:${port}`);
    return {
      isAddressAllowed,
      isPrivateIP,
      isSSRFTarget: (address, allowed, port) =>
        !isAddressAllowed(address, allowed, port) &&
        (address === 'localhost' || isPrivateIP(address)),
    };
  },
  { virtual: true },
);

const { createReadOnlyPostgresExecutor, parseConnectionString } = require('./postgres');

function clientHarness(rows = [{ id: 1 }]) {
  const instances = [];
  const cursors = [];
  class Cursor {
    constructor(text, values) {
      this.text = text;
      this.values = values;
      this.remaining = [...rows];
      this.close = jest.fn().mockResolvedValue(undefined);
      this.read = jest.fn(async (count) => this.remaining.splice(0, count));
      cursors.push(this);
    }
  }
  class Client {
    constructor(config) {
      this.config = config;
      this.connect = jest.fn().mockResolvedValue(undefined);
      this.end = jest.fn().mockResolvedValue(undefined);
      this.query = jest.fn((text) => {
        if (text instanceof Cursor) return text;
        return Promise.resolve({ rows: [] });
      });
      instances.push(this);
    }
  }
  return { Client, Cursor, cursors, instances };
}

const publicLookup = jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]);

describe('PostgreSQL knowledge connector runtime', () => {
  beforeEach(() => publicLookup.mockClear());

  it('accepts only URL connection strings whose connection options LibreChat controls', () => {
    expect(parseConnectionString('postgresql://user:pass@db.example.com/app')).toMatchObject({
      hostname: 'db.example.com',
      port: '5432',
      user: 'user',
      password: 'pass',
      database: 'app',
    });
    expect(() =>
      parseConnectionString('postgresql://user@db.example.com/app?sslmode=disable'),
    ).toThrow('managed by LibreChat: sslmode');
    expect(() => parseConnectionString('file:///tmp/postgres')).toThrow('postgres or postgresql');
  });

  it('pins the resolved address, verifies TLS, and runs inside a read-only transaction', async () => {
    const { Client, Cursor, cursors, instances } = clientHarness();
    const execute = createReadOnlyPostgresExecutor({ Client, Cursor, lookup: publicLookup });

    await expect(
      execute('postgresql://user:pass@db.example.com/app', 'SELECT data FROM docs', ['a']),
    ).resolves.toEqual([{ id: 1 }]);

    expect(instances[0].config).toMatchObject({
      host: '8.8.8.8',
      ssl: { rejectUnauthorized: true, servername: 'db.example.com' },
      connectionTimeoutMillis: 10_000,
      query_timeout: 16_000,
    });
    expect(instances[0].query).toHaveBeenNthCalledWith(1, 'BEGIN READ ONLY');
    expect(instances[0].query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('statement_timeout', $1, true)",
      ['15000ms'],
    );
    expect(cursors[0]).toMatchObject({ text: 'SELECT data FROM docs', values: ['a'] });
    expect(instances[0].query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(cursors[0].close).toHaveBeenCalledTimes(1);
    expect(instances[0].end).toHaveBeenCalledTimes(1);
  });

  it('blocks private targets unless an administrator allowlists the exact host and port', async () => {
    const privateLookup = jest.fn(async () => [{ address: '10.0.0.8', family: 4 }]);
    const blocked = createReadOnlyPostgresExecutor({
      ...clientHarness(),
      lookup: privateLookup,
    });
    await expect(
      blocked('postgresql://user:pass@db.internal.example:5432/app', 'SELECT data', []),
    ).rejects.toThrow('restricted address');

    const { Client, Cursor, instances } = clientHarness();
    const allowed = createReadOnlyPostgresExecutor({
      Client,
      Cursor,
      lookup: privateLookup,
      allowedAddresses: ['db.internal.example:5432'],
    });
    await allowed('postgresql://user:pass@db.internal.example:5432/app', 'SELECT data', []);
    expect(instances[0].config.host).toBe('10.0.0.8');
  });

  it('fails closed on DNS errors and mixed public/private answers', async () => {
    const harness = clientHarness();
    const unresolved = createReadOnlyPostgresExecutor({
      Client: harness.Client,
      Cursor: harness.Cursor,
      lookup: jest.fn(async () => {
        throw new Error('DNS unavailable');
      }),
    });
    await expect(
      unresolved('postgresql://user:pass@db.example.com/app', 'SELECT data', []),
    ).rejects.toThrow('could not be resolved');

    const mixed = createReadOnlyPostgresExecutor({
      Client: harness.Client,
      Cursor: harness.Cursor,
      lookup: jest.fn(async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]),
    });
    await expect(
      mixed('postgresql://user:pass@db.example.com/app', 'SELECT data', []),
    ).rejects.toThrow('resolves to a restricted address');
    expect(harness.instances).toHaveLength(0);
  });

  it('keeps plaintext opt-in deployment controlled', async () => {
    const { Client, Cursor, instances } = clientHarness();
    const execute = createReadOnlyPostgresExecutor({
      Client,
      Cursor,
      lookup: publicLookup,
      allowPlaintext: true,
    });
    await execute('postgresql://user:pass@db.example.com/app', 'SELECT data', []);
    expect(instances[0].config.ssl).toBe(false);
  });

  it('rolls back and closes when row or byte limits are exceeded', async () => {
    const rows = [{ value: '12345' }, { value: '67890' }];
    const { Client, Cursor, instances } = clientHarness(rows);
    const execute = createReadOnlyPostgresExecutor({
      Client,
      Cursor,
      lookup: publicLookup,
      maxRows: 1,
      maxBytes: 1_024,
    });
    await expect(
      execute('postgresql://user:pass@db.example.com/app', 'SELECT data', []),
    ).rejects.toThrow('1 row limit');
    expect(instances[0].query).toHaveBeenCalledWith('ROLLBACK');
    expect(instances[0].end).toHaveBeenCalledTimes(1);

    const bytes = clientHarness([{ value: 'x'.repeat(2_000) }]);
    const byteLimited = createReadOnlyPostgresExecutor({
      Client: bytes.Client,
      Cursor: bytes.Cursor,
      lookup: publicLookup,
      maxBytes: 1_024,
    });
    await expect(
      byteLimited('postgresql://user:pass@db.example.com/app', 'SELECT data', []),
    ).rejects.toThrow('1024 byte limit');
    expect(bytes.instances[0].query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects non-read queries before opening a connection', async () => {
    const { Client, Cursor, instances } = clientHarness();
    const execute = createReadOnlyPostgresExecutor({ Client, Cursor, lookup: publicLookup });
    await expect(
      execute('postgresql://user:pass@db.example.com/app', 'DELETE FROM docs', []),
    ).rejects.toThrow('only execute SELECT');
    expect(instances).toHaveLength(0);
  });
});
