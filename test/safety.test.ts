import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeQuery, openReadOnlyDatabase } from '../src/db/connection.js';
import { SqliteExecutor } from '../src/db/executor.js';
import { ExplorerError } from '../src/errors.js';
import {
  callTool,
  connect,
  customDatabase,
  demoDatabase,
  type Harness,
  type QueryOutcome,
  tempDir,
} from './helpers.js';

const dir = tempDir();
let databasePath: string;
let harness: Harness;

const fingerprint = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

beforeAll(async () => {
  databasePath = demoDatabase(dir);
  harness = await connect(databasePath, { maxRows: 100, defaultRows: 20 });
});

afterAll(async () => {
  await harness?.close();
  dir.remove();
});

describe('read-only connection', () => {
  it('refuses writes at the connection level, independent of statement checks', () => {
    const db = openReadOnlyDatabase(databasePath);
    try {
      expect(db.readonly).toBe(true);
      expect(db.pragma('query_only', { simple: true })).toBe(1n);
      expect(db.pragma('trusted_schema', { simple: true })).toBe(0n);
      expect(() => db.exec('DELETE FROM invoice_lines')).toThrow(/readonly|query_only/i);
      expect(() => db.exec('CREATE TABLE intruder (a)')).toThrow(/readonly|query_only/i);
    } finally {
      db.close();
    }
  });

  it('refuses to open a database file that does not exist (no accidental creation)', () => {
    expect(() => openReadOnlyDatabase(dir.file('missing.db'))).toThrow();
    expect(() => new SqliteExecutor({ databasePath: dir.file('missing.db'), timeoutMs: 1000 })).toThrow(
      /not found/,
    );
  });

  it('rejects data-modifying statements even when the text guard is bypassed', async () => {
    const limits = { maxRows: 10, maxOutputBytes: 10_000, maxCellChars: 100 };
    await expect(harness.executor.query('DELETE FROM tracks', [], limits)).rejects.toMatchObject({
      code: 'NOT_READ_ONLY',
    });
    await expect(harness.executor.query("ATTACH DATABASE ':memory:' AS m", [], limits)).rejects.toMatchObject({
      code: 'NOT_SELECT',
    });
    const db = openReadOnlyDatabase(databasePath);
    try {
      expect(() => executeQuery(db, 'UPDATE tracks SET title = 1', [], limits)).toThrow(ExplorerError);
    } finally {
      db.close();
    }
  });

  it('leaves the database file byte-for-byte unchanged after hostile input', async () => {
    const before = fingerprint(databasePath);
    const attempts = [
      'DELETE FROM tracks',
      'DROP TABLE tracks',
      'SELECT 1; DROP TABLE tracks',
      'WITH x AS (SELECT 1) DELETE FROM tracks',
      'WITH x AS (SELECT 1) INSERT INTO genres (name) SELECT \'Polka\' FROM x',
      "ATTACH DATABASE 'evil.db' AS evil",
      'PRAGMA user_version = 99',
      'VACUUM',
      "SELECT * FROM tracks; UPDATE tracks SET title = 'x'",
    ];
    for (const sql of attempts) {
      const result = await callTool(harness.client, 'run_query', { sql });
      expect(result.isError, sql).toBe(true);
    }
    expect(fingerprint(databasePath)).toBe(before);
  });
});

describe('statement rules', () => {
  it.each([
    ['INSERT INTO genres (name) VALUES (\'Polka\')', 'NOT_SELECT'],
    ['UPDATE tracks SET title = \'x\'', 'NOT_SELECT'],
    ['DELETE FROM tracks', 'NOT_SELECT'],
    ['DROP TABLE tracks', 'NOT_SELECT'],
    ['PRAGMA table_info(tracks)', 'NOT_SELECT'],
    ["ATTACH DATABASE ':memory:' AS m", 'NOT_SELECT'],
    ['SELECT 1; SELECT 2', 'MULTIPLE_STATEMENTS'],
    ['   ', 'EMPTY_QUERY'],
    ["SELECT 'unterminated", 'UNTERMINATED_TOKEN'],
    ['WITH doomed AS (SELECT track_id FROM tracks) DELETE FROM tracks WHERE track_id IN doomed', 'NOT_READ_ONLY'],
  ])('run_query rejects %j with %s', async (sql, code) => {
    const result = await callTool(harness.client, 'run_query', { sql });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith(`[${code}]`)).toBe(true);
  });

  it.each([
    ['DELETE FROM tracks', 'NOT_SELECT'],
    ['SELECT 1; SELECT 2', 'MULTIPLE_STATEMENTS'],
    ['WITH x AS (SELECT 1) UPDATE tracks SET title = \'y\'', 'NOT_READ_ONLY'],
  ])('explain_query applies the same rules to %j', async (sql, code) => {
    const result = await callTool(harness.client, 'explain_query', { sql });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith(`[${code}]`)).toBe(true);
  });
});

describe('row limit', () => {
  it('applies the default row limit and reports truncation', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', { sql: 'SELECT * FROM tracks' });
    expect(result.structured.rowCount).toBe(20);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.truncatedReason).toBe('max_rows');
    expect(result.text).toContain('truncated: row limit reached');
  });

  it('honours max_rows', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: 'SELECT track_id FROM tracks',
      max_rows: 5,
    });
    expect(result.structured.rows).toHaveLength(5);
  });

  it('rejects a max_rows above the configured cap through schema validation', async () => {
    const result = await callTool(harness.client, 'run_query', { sql: 'SELECT 1', max_rows: 101 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/max_rows/);
  });

  it('caps sample_rows the same way', async () => {
    const result = await callTool(harness.client, 'sample_rows', { table: 'tracks', limit: 1000 });
    expect(result.isError).toBe(true);
  });

  it('stops reading an unbounded result set instead of materialising it', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT x FROM n',
      max_rows: 3,
    });
    expect(result.structured.rows).toEqual([[1], [2], [3]]);
    expect(result.structured.truncated).toBe(true);
  });
});

describe('output size cap', () => {
  let small: Harness;

  beforeAll(async () => {
    small = await connect(databasePath, { maxOutputBytes: 2_048, maxCellChars: 40, maxRows: 1_000 });
  });

  afterAll(async () => {
    await small?.close();
  });

  it('stops before the serialised rows exceed the byte budget', async () => {
    const result = await callTool<QueryOutcome>(small.client, 'run_query', {
      sql: 'SELECT * FROM tracks',
      max_rows: 1_000,
    });
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.truncatedReason).toBe('max_output_bytes');
    expect(result.structured.rowCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.structured.rows))).toBeLessThanOrEqual(2_048);
    expect(result.text).toContain('truncated: output size limit reached');
  });

  it('cuts long text values and marks the cut', async () => {
    const result = await callTool<QueryOutcome>(small.client, 'run_query', {
      sql: "SELECT replace(hex(zeroblob(500)), '00', 'ab') AS long_text",
    });
    const cell = result.structured.rows[0]?.[0] as string;
    expect(cell.startsWith('ab'.repeat(20))).toBe(true);
    expect(cell).toMatch(/… \[960 more chars\]$/);
  });

  it('replaces blobs with a size placeholder', async () => {
    const result = await callTool<QueryOutcome>(small.client, 'run_query', { sql: 'SELECT randomblob(64) AS b' });
    expect(result.structured.rows).toEqual([['<blob 64 bytes>']]);
  });

});

describe('query timeout', () => {
  let fast: Harness;

  beforeAll(async () => {
    fast = await connect(databasePath, { timeoutMs: 300 });
  });

  afterAll(async () => {
    await fast?.close();
  });

  it('kills a runaway query and keeps serving afterwards', async () => {
    const started = Date.now();
    const runaway = await callTool(fast.client, 'run_query', {
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n',
    });
    const elapsed = Date.now() - started;
    expect(runaway.isError).toBe(true);
    expect(runaway.text).toMatch(/^\[TIMEOUT\] The query exceeded the 300 ms time limit/);
    expect(elapsed).toBeLessThan(5_000);

    const next = await callTool<QueryOutcome>(fast.client, 'run_query', { sql: 'SELECT count(*) FROM genres' });
    expect(next.isError).toBe(false);
    expect(next.structured.rows).toEqual([[10]]);
  });

  it('only cancels the statement that ran out of time, not queued ones', async () => {
    const [slow, quick] = await Promise.all([
      callTool(fast.client, 'run_query', {
        sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT max(x) FROM n',
      }),
      callTool<QueryOutcome>(fast.client, 'run_query', { sql: 'SELECT 1 AS one' }),
    ]);
    expect(slow.text).toMatch(/^\[TIMEOUT\]/);
    expect(quick.isError).toBe(false);
    expect(quick.structured.rows).toEqual([[1]]);
  });
});

describe('worker isolation', () => {
  let patient: Harness;

  beforeAll(async () => {
    patient = await connect(databasePath, { timeoutMs: 10_000 });
    // Warm up so the worker process exists before the test kills it.
    await callTool(patient.client, 'run_query', { sql: 'SELECT 1' });
  });

  afterAll(async () => {
    await patient?.close();
  });

  it('survives the worker process dying mid-query', async () => {
    const pending = callTool(patient.client, 'run_query', {
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT sum(x) FROM n',
    });
    for (let waited = 0; !patient.executor.busy && waited < 5_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(patient.executor.busy).toBe(true);
    const pid = patient.executor.workerPid;
    expect(pid).toBeTypeOf('number');
    process.kill(pid as number, 'SIGKILL');

    const crashed = await pending;
    expect(crashed.isError).toBe(true);
    expect(crashed.text).toMatch(/^\[WORKER_FAILURE\] The query worker exited unexpectedly/);

    const next = await callTool<QueryOutcome>(patient.client, 'run_query', { sql: 'SELECT 2 AS two' });
    expect(next.structured.rows).toEqual([[2]]);
    expect(patient.executor.workerPid).not.toBe(pid);
  });

  it('reports a database that cannot be opened instead of hanging', async () => {
    const notSqlite = dir.file('not-a-database.db');
    writeFileSync(notSqlite, 'this is not a sqlite file '.repeat(100));
    const broken = await connect(notSqlite);
    try {
      const result = await callTool(broken.client, 'list_tables');
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^\[WORKER_FAILURE\] Cannot open .*not-a-database\.db/);
    } finally {
      await broken.close();
    }
  });
});

describe('identifier validation', () => {
  let odd: Harness;

  beforeAll(async () => {
    const path = customDatabase(
      dir,
      'odd.db',
      `CREATE TABLE "order details" ("line id" INTEGER PRIMARY KEY, "qty""x" INTEGER);
       INSERT INTO "order details" VALUES (1, 5), (2, 7);
       CREATE TABLE Mixed (Id INTEGER PRIMARY KEY);`,
    );
    odd = await connect(path);
  });

  afterAll(async () => {
    await odd?.close();
  });

  it.each([
    ['describe_table', { table: 'nope' }],
    ['describe_table', { table: 'tracks; DROP TABLE tracks' }],
    ['describe_table', { table: 'tracks" --' }],
    ['sample_rows', { table: 'sqlite_schema' }],
    ['sample_rows', { table: "tracks WHERE 1=1 UNION SELECT name, sql, 1, 1, 1, 1, 1 FROM sqlite_schema" }],
  ])('%s rejects unknown table %j', async (tool, args) => {
    const result = await callTool(harness.client, tool, args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[UNKNOWN_TABLE\]/);
    expect(result.text).toContain('Known tables: albums, artists');
  });

  it('rejects unknown and injected column names', async () => {
    for (const column of ['nope', 'title FROM tracks; --', '*']) {
      const result = await callTool(harness.client, 'sample_rows', { table: 'tracks', columns: ['title', column] });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^\[UNKNOWN_COLUMN\]/);
    }
  });

  it('resolves names case-insensitively to the real identifier', async () => {
    const result = await callTool<QueryOutcome & { table: string }>(harness.client, 'sample_rows', {
      table: 'TRACKS',
      columns: ['TITLE'],
      limit: 1,
    });
    expect(result.isError).toBe(false);
    expect(result.structured.table).toBe('tracks');
    expect(result.structured.columns).toEqual(['title']);
  });

  it('quotes real identifiers that contain spaces and quotes', async () => {
    const described = await callTool<{ columns: Array<{ name: string }> }>(odd.client, 'describe_table', {
      table: 'order details',
    });
    expect(described.structured.columns.map((column) => column.name)).toEqual(['line id', 'qty"x']);

    const sampled = await callTool<QueryOutcome>(odd.client, 'sample_rows', {
      table: 'order details',
      columns: ['qty"x'],
    });
    expect(sampled.isError).toBe(false);
    expect(sampled.structured.rows).toEqual([[5], [7]]);

    const mixed = await callTool<{ name: string }>(odd.client, 'describe_table', { table: 'mixed' });
    expect(mixed.structured.name).toBe('Mixed');
  });
});
