import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, connect, demoDatabase, type Harness, type QueryOutcome, tempDir } from './helpers.js';

const dir = tempDir();
let harness: Harness;

beforeAll(async () => {
  harness = await connect(demoDatabase(dir));
});

afterAll(async () => {
  await harness?.close();
  dir.remove();
});

describe('tool registry', () => {
  it('advertises the five tools as read-only with input and output schemas', async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'describe_table',
      'explain_query',
      'list_tables',
      'run_query',
      'sample_rows',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }
  });
});

describe('list_tables', () => {
  it('lists tables and views with column counts', async () => {
    const result = await callTool<{ tables: Array<{ name: string; type: string; columnCount: number }> }>(
      harness.client,
      'list_tables',
    );
    expect(result.isError).toBe(false);
    const byName = Object.fromEntries(result.structured.tables.map((table) => [table.name, table]));
    expect(Object.keys(byName)).toEqual([
      'albums',
      'artists',
      'customers',
      'genres',
      'invoice_lines',
      'invoices',
      'sales_by_genre',
      'tracks',
    ]);
    expect(byName.tracks).toEqual({ name: 'tracks', type: 'table', columnCount: 7 });
    expect(byName.sales_by_genre?.type).toBe('view');
    expect(result.text).toContain('- tracks (table, 7 columns)');
  });

  it('can leave views out', async () => {
    const result = await callTool<{ tables: Array<{ type: string }> }>(harness.client, 'list_tables', {
      include_views: false,
    });
    expect(result.structured.tables.every((table) => table.type === 'table')).toBe(true);
  });
});

describe('describe_table', () => {
  it('returns columns, primary key, foreign keys, indexes and row count', async () => {
    const result = await callTool<{
      name: string;
      columns: Array<{ name: string; type: string; notNull: boolean; primaryKeyPosition: number }>;
      primaryKey: string[];
      foreignKeys: Array<{ columns: string[]; referencesTable: string; referencesColumns: string[]; onDelete: string }>;
      indexes: Array<{ name: string; unique: boolean; origin: string; columns: string[] }>;
      rowCount: number;
      sql: string;
    }>(harness.client, 'describe_table', { table: 'tracks' });

    expect(result.isError).toBe(false);
    const table = result.structured;
    expect(table.columns.map((column) => column.name)).toEqual([
      'track_id',
      'album_id',
      'track_number',
      'title',
      'composer',
      'duration_ms',
      'unit_price_cents',
    ]);
    expect(table.columns.find((column) => column.name === 'composer')).toMatchObject({ type: 'TEXT', notNull: false });
    expect(table.primaryKey).toEqual(['track_id']);
    expect(table.foreignKeys).toEqual([
      {
        columns: ['album_id'],
        referencesTable: 'albums',
        referencesColumns: ['album_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      },
    ]);
    expect(table.indexes).toEqual(
      expect.arrayContaining([
        { name: 'idx_tracks_album', unique: false, origin: 'create_index', partial: false, columns: ['album_id'] },
        expect.objectContaining({ unique: true, origin: 'unique_constraint', columns: ['album_id', 'track_number'] }),
      ]),
    );
    expect(table.rowCount).toBeGreaterThan(500);
    expect(table.sql).toMatch(/^CREATE TABLE tracks/);
    expect(result.text).toContain('Foreign keys:');
  });

  it('describes views', async () => {
    const result = await callTool<{ type: string; columns: Array<{ name: string }>; rowCount: number }>(
      harness.client,
      'describe_table',
      { table: 'sales_by_genre' },
    );
    expect(result.structured.type).toBe('view');
    expect(result.structured.columns.map((column) => column.name)).toEqual(['genre', 'lines_sold', 'revenue']);
    expect(result.structured.rowCount).toBeGreaterThan(0);
  });
});

describe('sample_rows', () => {
  it('returns the first rows of a table with the default limit', async () => {
    const result = await callTool<QueryOutcome & { table: string }>(harness.client, 'sample_rows', { table: 'artists' });
    expect(result.isError).toBe(false);
    expect(result.structured.table).toBe('artists');
    expect(result.structured.columns).toEqual(['artist_id', 'name', 'country', 'formed_year']);
    expect(result.structured.rowCount).toBe(10);
    expect(result.structured.truncated).toBe(true);
    expect(result.text).toMatch(/^\| artist_id \| name \| country \| formed_year \|/);
  });

  it('projects selected columns and honours the limit', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'sample_rows', {
      table: 'tracks',
      columns: ['title', 'duration_ms'],
      limit: 3,
    });
    expect(result.structured.columns).toEqual(['title', 'duration_ms']);
    expect(result.structured.rows).toHaveLength(3);
  });

  it('does not report truncation when the table has fewer rows than the limit', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'sample_rows', { table: 'genres', limit: 50 });
    expect(result.structured.rowCount).toBe(10);
    expect(result.structured.truncated).toBe(false);
  });

  it('can sample at random', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'sample_rows', {
      table: 'customers',
      limit: 5,
      random: true,
    });
    expect(result.isError).toBe(false);
    expect(result.structured.rows).toHaveLength(5);
  });
});

describe('run_query', () => {
  it('runs a SELECT with bound parameters', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: 'SELECT name FROM genres WHERE genre_id IN (?, ?) ORDER BY genre_id',
      params: [1, 3],
    });
    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      columns: ['name'],
      rows: [['Ambient'], ['Classical']],
      rowCount: 2,
      truncated: false,
    });
  });

  it('runs CTEs and aggregates across joins', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: `WITH revenue AS (
              SELECT i.billing_country AS country, sum(i.total_cents) AS cents
                FROM invoices AS i GROUP BY i.billing_country)
            SELECT country, cents FROM revenue ORDER BY cents DESC LIMIT 3`,
    });
    expect(result.isError).toBe(false);
    expect(result.structured.rows).toHaveLength(3);
    const cents = result.structured.rows.map((row) => row[1] as number);
    expect([...cents].sort((a, b) => b - a)).toEqual(cents);
  });

  it('binds booleans as 0/1 and nulls as NULL', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: 'SELECT ? AS t, ? AS f, ? IS NULL AS n',
      params: [true, false, null],
    });
    expect(result.structured.rows).toEqual([[1, 0, 1]]);
  });

  it('keeps integers beyond 2^53 exact by returning them as strings', async () => {
    const result = await callTool<QueryOutcome>(harness.client, 'run_query', {
      sql: 'SELECT 9007199254740993 AS big, 42 AS small',
    });
    expect(result.structured.rows).toEqual([['9007199254740993', 42]]);
  });

  it('returns SQLite errors as tool errors the model can act on', async () => {
    const result = await callTool(harness.client, 'run_query', { sql: 'SELECT nope FROM tracks' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[SQL_ERROR\] .*no such column: nope/);
  });

  it('reports missing parameters', async () => {
    const result = await callTool(harness.client, 'run_query', { sql: 'SELECT ? + ?', params: [1] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^\[SQL_ERROR\]/);
  });
});

describe('explain_query', () => {
  it('returns the plan as rows and as a tree, flagging full scans', async () => {
    const result = await callTool<{ plan: Array<{ detail: string }>; fullScans: string[] }>(
      harness.client,
      'explain_query',
      {
        sql: 'SELECT t.title FROM tracks AS t JOIN albums AS a ON a.album_id = t.album_id WHERE a.artist_id = ?',
        params: [1],
      },
    );
    expect(result.isError).toBe(false);
    const details = result.structured.plan.map((step) => step.detail).join('\n');
    expect(details).toMatch(/idx_albums_artist/);
    expect(details).toMatch(/idx_tracks_album/);
    expect(result.structured.fullScans).toEqual([]);
    expect(result.text.split('\n')[0]).toBe('QUERY PLAN');
    expect(result.text).toMatch(/(\|--|`--)SEARCH/);
  });

  it('flags a full table scan', async () => {
    const result = await callTool<{ fullScans: string[] }>(harness.client, 'explain_query', {
      sql: "SELECT * FROM customers WHERE city = 'Zurich'",
    });
    expect(result.structured.fullScans).toEqual(['SCAN customers']);
  });

  it('does not run the query', async () => {
    const result = await callTool(harness.client, 'explain_query', {
      sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n',
    });
    expect(result.isError).toBe(false);
  });
});
