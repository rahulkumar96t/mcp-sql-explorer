import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate, completable } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ExplorerLimits } from './config.js';
import { SchemaCatalog, type TableDescription } from './db/catalog.js';
import type { SqliteExecutor } from './db/executor.js';
import { ExplorerError, isExplorerError } from './errors.js';
import { renderPlanTree, renderResultTable } from './format.js';
import { guardSelect, quoteIdentifier } from './sql/guard.js';

export const SERVER_NAME = 'mcp-sql-explorer';
export const SERVER_VERSION = '0.1.0';

export interface ExplorerServerOptions {
  executor: SqliteExecutor;
  limits: ExplorerLimits;
}

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const INSTRUCTIONS = `Read-only access to one SQLite database.
Suggested workflow: list_tables -> describe_table -> sample_rows -> run_query.
Only a single SELECT (or WITH ... SELECT) statement is accepted per call; use ? placeholders with "params" for values.
Results are capped in rows and bytes and every query has a time limit; "truncated: true" means more data exists.
Use explain_query to check that a query uses an index before running it on a large table.`;

const SqlParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const CellSchema = z.union([z.string(), z.number(), z.null()]);

const QueryResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(CellSchema)).describe('Row values in column order'),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  truncatedReason: z.enum(['max_rows', 'max_output_bytes']).optional(),
  elapsedMs: z.number(),
});

const TableSummarySchema = z.object({
  name: z.string(),
  type: z.enum(['table', 'view']),
  columnCount: z.number().int(),
});

const TableDescriptionSchema = z.object({
  name: z.string(),
  type: z.enum(['table', 'view']),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      notNull: z.boolean(),
      defaultValue: z.string().nullable(),
      primaryKeyPosition: z.number().int(),
    }),
  ),
  primaryKey: z.array(z.string()),
  foreignKeys: z.array(
    z.object({
      columns: z.array(z.string()),
      referencesTable: z.string(),
      referencesColumns: z.array(z.string()),
      onUpdate: z.string(),
      onDelete: z.string(),
    }),
  ),
  indexes: z.array(
    z.object({
      name: z.string(),
      unique: z.boolean(),
      origin: z.enum(['create_index', 'unique_constraint', 'primary_key']),
      partial: z.boolean(),
      columns: z.array(z.string()),
    }),
  ),
  rowCount: z.number().int().nullable(),
  sql: z.string().nullable(),
});

/**
 * Builds an MCP server over an executor. The executor (and its worker process) is owned by the
 * caller so several server instances can share it.
 */
export function createExplorerServer({ executor, limits }: ExplorerServerOptions): McpServer {
  const catalog = new SchemaCatalog(executor);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const outputLimits = (maxRows: number) => ({
    maxRows,
    maxOutputBytes: limits.maxOutputBytes,
    maxCellChars: limits.maxCellChars,
  });

  const tableNames = async (prefix: string): Promise<string[]> => {
    const tables = await catalog.listTables();
    const lower = prefix.toLowerCase();
    return tables.map((table) => table.name).filter((name) => name.toLowerCase().startsWith(lower));
  };

  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description: 'List the tables and views in the database with their column counts.',
      inputSchema: z.object({
        include_views: z.boolean().default(true).describe('Include views as well as tables'),
      }),
      outputSchema: z.object({ tables: z.array(TableSummarySchema) }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ include_views }) =>
      run(async () => {
        const all = await catalog.listTables();
        const tables = include_views ? all : all.filter((table) => table.type === 'table');
        const text = tables.length
          ? tables.map((table) => `- ${table.name} (${table.type}, ${table.columnCount} columns)`).join('\n')
          : 'The database has no tables.';
        return { text, structured: { tables } };
      }),
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Columns with types, primary key, foreign keys, indexes, row count and the CREATE statement of one table or view.',
      inputSchema: z.object({ table: z.string().min(1).describe('Table or view name, as returned by list_tables') }),
      outputSchema: TableDescriptionSchema,
      annotations: READ_ONLY_TOOL,
    },
    async ({ table }) =>
      run(async () => {
        const description = await catalog.describeTable(table);
        return { text: describeAsText(description), structured: description };
      }),
  );

  server.registerTool(
    'sample_rows',
    {
      title: 'Sample rows',
      description: 'Return a few rows from a table, optionally only some columns, in storage order or at random.',
      inputSchema: z.object({
        table: z.string().min(1).describe('Table or view name'),
        columns: z.array(z.string().min(1)).max(100).optional().describe('Columns to return (default: all)'),
        limit: z.number().int().min(1).max(limits.maxRows).default(Math.min(10, limits.maxRows)),
        random: z.boolean().default(false).describe('Pick rows at random (ORDER BY random(); scans the table)'),
      }),
      outputSchema: QueryResultSchema.extend({ table: z.string() }),
      annotations: { ...READ_ONLY_TOOL, idempotentHint: false },
    },
    async ({ table, columns, limit, random }) =>
      run(async () => {
        const resolved = await catalog.resolveTable(table);
        const selected = columns?.length ? await catalog.resolveColumns(resolved.name, columns) : undefined;
        const projection = selected ? selected.map(quoteIdentifier).join(', ') : '*';
        const sql = `SELECT ${projection} FROM ${quoteIdentifier(resolved.name)}${random ? ' ORDER BY random()' : ''} LIMIT ?`;
        // Fetch one extra row so a full table is not reported as truncated.
        const result = await executor.query(sql, [limit + 1], outputLimits(limit));
        return { text: renderResultTable(result), structured: { table: resolved.name, ...result } };
      }),
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run query',
      description:
        'Run one read-only SELECT (or WITH ... SELECT) statement. Bind values with ? placeholders and "params". ' +
        `Results are capped at max_rows rows (default ${limits.defaultRows}, up to ${limits.maxRows}) and ` +
        `${limits.maxOutputBytes} bytes; queries are cancelled after ${limits.timeoutMs} ms.`,
      inputSchema: z.object({
        sql: z.string().min(1).max(100_000).describe('A single SELECT or WITH ... SELECT statement'),
        params: z.array(SqlParamSchema).max(1_000).default([]).describe('Values for ? placeholders, in order'),
        max_rows: z.number().int().min(1).max(limits.maxRows).default(limits.defaultRows),
      }),
      outputSchema: QueryResultSchema,
      annotations: READ_ONLY_TOOL,
    },
    async ({ sql, params, max_rows }) =>
      run(async () => {
        const guarded = guardSelect(sql);
        const result = await executor.query(guarded.sql, params, outputLimits(max_rows));
        return { text: renderResultTable(result), structured: result };
      }),
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain query',
      description: "Show SQLite's query plan (EXPLAIN QUERY PLAN) for a SELECT without running it.",
      inputSchema: z.object({
        sql: z.string().min(1).max(100_000).describe('A single SELECT or WITH ... SELECT statement'),
        params: z.array(SqlParamSchema).max(1_000).default([]).describe('Values for ? placeholders, in order'),
      }),
      outputSchema: z.object({
        plan: z.array(z.object({ id: z.number().int(), parent: z.number().int(), detail: z.string() })),
        fullScans: z.array(z.string()).describe('Plan steps that scan a whole table'),
      }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ sql, params }) =>
      run(async () => {
        const guarded = guardSelect(sql);
        const plan = await executor.explain(guarded.sql, params);
        const fullScans = plan.map((step) => step.detail).filter((detail) => /^SCAN /.test(detail));
        return { text: renderPlanTree(plan), structured: { plan, fullScans } };
      }),
  );

  server.registerResource(
    'database-schema',
    'sqlite://schema',
    {
      title: 'Database schema',
      description: 'CREATE statements for every table, view, index and trigger',
      mimeType: 'application/sql',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/sql', text: await catalog.schemaSql() }],
    }),
  );

  server.registerResource(
    'table-schema',
    new ResourceTemplate('sqlite://table/{name}', {
      list: async () => ({
        resources: (await catalog.listTables()).map((table) => ({
          uri: tableUri(table.name),
          name: table.name,
          title: `${table.type === 'view' ? 'View' : 'Table'} ${table.name}`,
          mimeType: 'application/json',
        })),
      }),
      complete: { name: tableNames },
    }),
    {
      title: 'Table schema',
      description: 'Structure of one table or view as JSON (same shape as describe_table)',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const description = await describeForProtocol(catalog, decodeVariable(variables.name));
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(description, null, 2) }],
      };
    },
  );

  server.registerPrompt(
    'analyse-table',
    {
      title: 'Analyse a table',
      description: 'Profile one table: data quality, distributions, relationships and anomalies.',
      argsSchema: z.object({
        table: completable(z.string().describe('Table or view to analyse'), tableNames),
        focus: z.string().optional().describe('Optional question or area to concentrate on'),
      }),
    },
    async ({ table, focus }) => {
      const description = await describeForProtocol(catalog, table);
      return {
        description: `Analyse ${description.name}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'resource' as const,
              resource: {
                uri: tableUri(description.name),
                mimeType: 'application/json',
                text: JSON.stringify(description, null, 2),
              },
            },
          },
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: analysisPrompt(description, focus, limits) },
          },
        ],
      };
    },
  );

  return server;
}

/** Normalises tool handler results and turns safety errors into `isError` results with codes. */
async function run(
  work: () => Promise<{ text: string; structured: object }>,
): Promise<{ content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  try {
    const { text, structured } = await work();
    return { content: [{ type: 'text', text }], structuredContent: { ...structured } };
  } catch (error) {
    const message = isExplorerError(error) ? error.toString() : `[INTERNAL] ${(error as Error).message}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function describeForProtocol(catalog: SchemaCatalog, table: string): Promise<TableDescription> {
  try {
    return await catalog.describeTable(table);
  } catch (error) {
    if (error instanceof ExplorerError && error.code === 'UNKNOWN_TABLE') {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
    }
    throw error;
  }
}

function tableUri(name: string): string {
  return `sqlite://table/${encodeURIComponent(name)}`;
}

function decodeVariable(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join('/') : (value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function describeAsText(table: TableDescription): string {
  const lines = [`${table.type} ${table.name}: ${table.rowCount ?? 'unknown (count timed out)'} rows`, '', 'Columns:'];
  for (const column of table.columns) {
    const flags = [
      column.type || 'ANY',
      column.primaryKeyPosition ? 'PRIMARY KEY' : '',
      column.notNull ? 'NOT NULL' : '',
      column.defaultValue !== null ? `DEFAULT ${column.defaultValue}` : '',
    ].filter(Boolean);
    lines.push(`- ${column.name}: ${flags.join(' ')}`);
  }
  if (table.foreignKeys.length) {
    lines.push('', 'Foreign keys:');
    for (const fk of table.foreignKeys) {
      const target = fk.referencesColumns.length ? `(${fk.referencesColumns.join(', ')})` : '(primary key)';
      lines.push(`- (${fk.columns.join(', ')}) -> ${fk.referencesTable}${target} on delete ${fk.onDelete}`);
    }
  }
  if (table.indexes.length) {
    lines.push('', 'Indexes:');
    for (const index of table.indexes) {
      lines.push(`- ${index.name}${index.unique ? ' (unique)' : ''}: ${index.columns.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function analysisPrompt(table: TableDescription, focus: string | undefined, limits: ExplorerLimits): string {
  const related = table.foreignKeys.map((fk) => fk.referencesTable);
  return [
    `Analyse the ${table.type} "${table.name}" (${table.rowCount ?? 'unknown number of'} rows). Its structure is attached above.`,
    focus ? `Concentrate on: ${focus}` : '',
    '',
    'Use the read-only tools of this server (sample_rows, run_query, explain_query). Work step by step:',
    '1. Sample a few rows to see what the data looks like.',
    '2. Data quality: NULL counts and distinct counts per column; duplicate values in columns that look like keys.',
    '3. Distributions: min/max/average for numeric columns, top values for categorical ones, ranges for dates.',
    related.length
      ? `4. Relationships: check referential integrity against ${[...new Set(related)].join(', ')} and how rows spread across them.`
      : '4. Relationships: look for columns that reference other tables even without declared foreign keys.',
    '5. Anomalies: outliers, impossible values, suspicious gaps.',
    '',
    `Prefer aggregate queries over fetching raw rows; results are capped at ${limits.maxRows} rows and queries time out after ${limits.timeoutMs} ms.`,
    'Finish with a short summary of findings and suggested follow-up questions.',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');
}
