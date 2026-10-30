import Database from 'better-sqlite3';
import { ExplorerError, isExplorerError } from '../errors.js';
import type { Cell, OutputLimits, PlanStep, QueryResult, SqlParam, TruncationReason } from './protocol.js';

/**
 * Opens a connection that cannot write, in three independent layers:
 * 1. SQLITE_OPEN_READONLY (`readonly: true`), so the file handle itself is read-only;
 * 2. `PRAGMA query_only`, which makes SQLite refuse any statement that would change the file;
 * 3. `PRAGMA trusted_schema = OFF`, so views cannot call functions with side effects.
 * Statement classification (`assertReadOnlyQuery`) is applied on top of all three.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    // SQLite reads the file lazily; touch the schema now so a corrupt or non-SQLite file
    // fails at start-up rather than on the first query.
    db.prepare('SELECT count(*) FROM sqlite_schema').get();
  } catch (error) {
    db.close();
    throw error;
  }
  // Read INTEGERs as BigInt so values beyond 2^53 are not silently rounded; normalizeCell
  // turns them back into numbers when that is lossless.
  db.defaultSafeIntegers(true);
  return db;
}

/** Runs one read-only query and returns at most `limits.maxRows` normalised rows. */
export function executeQuery(
  db: Database.Database,
  sql: string,
  params: SqlParam[],
  limits: OutputLimits,
): QueryResult {
  const started = performance.now();
  const statement = prepare(db, sql);
  assertReadOnlyQuery(statement);
  statement.raw(true);

  const columns = statement.columns().map((column) => column.name);
  const rows: Cell[][] = [];
  let bytes = Buffer.byteLength(JSON.stringify(columns));
  let truncatedReason: TruncationReason | undefined;

  try {
    for (const raw of statement.iterate(...bindable(params)) as Iterable<unknown[]>) {
      if (rows.length >= limits.maxRows) {
        truncatedReason = 'max_rows';
        break;
      }
      const row = raw.map((value) => normalizeCell(value, limits.maxCellChars));
      const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + rowBytes > limits.maxOutputBytes) {
        truncatedReason = 'max_output_bytes';
        break;
      }
      bytes += rowBytes;
      rows.push(row);
    }
  } catch (error) {
    throw toExplorerError(error);
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: truncatedReason !== undefined,
    ...(truncatedReason ? { truncatedReason } : {}),
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** Returns SQLite's query plan for a read-only query without running the query. */
export function explainQuery(db: Database.Database, sql: string, params: SqlParam[]): PlanStep[] {
  assertReadOnlyQuery(prepare(db, sql));
  const plan = prepare(db, `EXPLAIN QUERY PLAN ${sql}`);
  plan.safeIntegers(false);
  try {
    const rows = plan.all(...bindable(params)) as Array<{ id: number; parent: number; detail: string }>;
    return rows.map(({ id, parent, detail }) => ({ id, parent, detail }));
  } catch (error) {
    throw toExplorerError(error);
  }
}

/**
 * Uses SQLite's own classification (sqlite3_stmt_readonly / column count) rather than text
 * matching. This catches statements the textual guard cannot see, such as
 * `WITH x AS (SELECT 1) DELETE FROM t`.
 */
export function assertReadOnlyQuery(statement: Database.Statement): void {
  if (!statement.readonly) {
    throw new ExplorerError(
      'NOT_READ_ONLY',
      'SQLite reports that this statement would modify the database. Only read-only SELECT queries are allowed.',
    );
  }
  if (!statement.reader) {
    throw new ExplorerError('NOT_SELECT', 'The statement does not return rows. Only SELECT queries are allowed.');
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export function normalizeCell(value: unknown, maxCellChars: number): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  const text = String(value);
  if (text.length <= maxCellChars) return text;
  return `${text.slice(0, maxCellChars)}… [${text.length - maxCellChars} more chars]`;
}

function prepare(db: Database.Database, sql: string): Database.Statement {
  try {
    return db.prepare(sql);
  } catch (error) {
    throw toExplorerError(error);
  }
}

function bindable(params: SqlParam[]): Array<string | number | null> {
  return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

/** Maps driver errors onto the public error codes. */
export function toExplorerError(error: unknown): ExplorerError {
  if (isExplorerError(error)) return error;
  if (error instanceof Database.SqliteError) {
    return new ExplorerError('SQL_ERROR', `${error.code}: ${error.message}`);
  }
  if (error instanceof Error) {
    if (/more than one statement/i.test(error.message)) {
      return new ExplorerError('MULTIPLE_STATEMENTS', 'Exactly one statement is allowed per call.');
    }
    if (error instanceof RangeError || error instanceof TypeError) {
      // better-sqlite3 reports bind problems ("Too few parameter values") this way.
      return new ExplorerError('SQL_ERROR', error.message);
    }
    return new ExplorerError('WORKER_FAILURE', error.message);
  }
  return new ExplorerError('WORKER_FAILURE', String(error));
}
