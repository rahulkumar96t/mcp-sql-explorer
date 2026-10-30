import { parseArgs } from 'node:util';
import { z } from 'zod';

export interface ExplorerLimits {
  /** Largest `max_rows` / `limit` a caller may request. */
  maxRows: number;
  /** Rows returned by run_query when the caller does not pass `max_rows`. */
  defaultRows: number;
  /** Upper bound on the JSON size of the rows in one result. */
  maxOutputBytes: number;
  /** Longer text cells are cut. */
  maxCellChars: number;
  /** Per-statement wall-clock budget; the worker is killed when it is exceeded. */
  timeoutMs: number;
}

export interface ExplorerConfig {
  databasePath: string;
  limits: ExplorerLimits;
}

export const DEFAULT_LIMITS: ExplorerLimits = {
  maxRows: 500,
  defaultRows: 50,
  maxOutputBytes: 64 * 1024,
  maxCellChars: 1_000,
  timeoutMs: 5_000,
};

export const USAGE = `Usage: mcp-sql-explorer --db <path-to-sqlite-file> [options]

Serves a SQLite database to MCP clients over stdio, read-only.

Options (each also settable through the environment variable in brackets):
  --db <path>               SQLite database file                     [SQL_EXPLORER_DB]
  --max-rows <n>            largest row limit a caller may request    [SQL_EXPLORER_MAX_ROWS]       default ${DEFAULT_LIMITS.maxRows}
  --default-rows <n>        rows returned when no limit is given      [SQL_EXPLORER_DEFAULT_ROWS]   default ${DEFAULT_LIMITS.defaultRows}
  --max-output-bytes <n>    cap on the JSON size of one result        [SQL_EXPLORER_MAX_OUTPUT_BYTES] default ${DEFAULT_LIMITS.maxOutputBytes}
  --max-cell-chars <n>      longer text values are cut                [SQL_EXPLORER_MAX_CELL_CHARS] default ${DEFAULT_LIMITS.maxCellChars}
  --timeout-ms <n>          per-query time limit                      [SQL_EXPLORER_TIMEOUT_MS]     default ${DEFAULT_LIMITS.timeoutMs}
  -h, --help                show this help
`;

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const ConfigSchema = z
  .object({
    db: z.string().min(1, 'a database path is required (--db or SQL_EXPLORER_DB)'),
    maxRows: int(1, 10_000).default(DEFAULT_LIMITS.maxRows),
    defaultRows: int(1, 10_000).default(DEFAULT_LIMITS.defaultRows),
    maxOutputBytes: int(1_024, 16 * 1024 * 1024).default(DEFAULT_LIMITS.maxOutputBytes),
    maxCellChars: int(16, 1_000_000).default(DEFAULT_LIMITS.maxCellChars),
    timeoutMs: int(50, 10 * 60 * 1000).default(DEFAULT_LIMITS.timeoutMs),
  })
  .refine((config) => config.defaultRows <= config.maxRows, {
    message: 'default-rows must not exceed max-rows',
    path: ['defaultRows'],
  });

export class ConfigError extends Error {}

/** Parses CLI flags, falling back to environment variables, then to defaults. */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): ExplorerConfig | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      'max-rows': { type: 'string' },
      'default-rows': { type: 'string' },
      'max-output-bytes': { type: 'string' },
      'max-cell-chars': { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return 'help';

  const parsed = ConfigSchema.safeParse({
    db: values.db ?? env.SQL_EXPLORER_DB,
    maxRows: values['max-rows'] ?? env.SQL_EXPLORER_MAX_ROWS,
    defaultRows: values['default-rows'] ?? env.SQL_EXPLORER_DEFAULT_ROWS,
    maxOutputBytes: values['max-output-bytes'] ?? env.SQL_EXPLORER_MAX_OUTPUT_BYTES,
    maxCellChars: values['max-cell-chars'] ?? env.SQL_EXPLORER_MAX_CELL_CHARS,
    timeoutMs: values['timeout-ms'] ?? env.SQL_EXPLORER_TIMEOUT_MS,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`);
    throw new ConfigError(problems.join('\n'));
  }

  const { db, ...limits } = parsed.data;
  return { databasePath: db, limits };
}
