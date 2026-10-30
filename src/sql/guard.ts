import { ExplorerError } from '../errors.js';

/** Result of a successful guard check. */
export interface GuardedQuery {
  /** The statement with any trailing semicolon (and trailing comments) removed. */
  sql: string;
  /** Upper-cased first keyword: `SELECT` or `WITH`. */
  leadingKeyword: 'SELECT' | 'WITH';
}

const ALLOWED_LEADING_KEYWORDS = new Set(['SELECT', 'WITH']);

interface ScannedStatement {
  text: string;
  firstWord: string | undefined;
}

/**
 * First line of defence for user-supplied SQL: exactly one statement, and it must start with
 * SELECT or WITH. The scanner understands comments, string literals, quoted identifiers and
 * blob literals, so `SELECT ';'` or `SELECT 1 -- ; DROP` are classified correctly.
 *
 * This is deliberately not a SQL parser. Whether the statement can write is decided later by
 * SQLite itself (`sqlite3_stmt_readonly`) inside the worker, and the connection is opened
 * read-only on top of that. The guard exists to fail fast with a clear message.
 */
export function guardSelect(input: string): GuardedQuery {
  const statements = scanStatements(input);

  if (statements.length === 0) {
    throw new ExplorerError('EMPTY_QUERY', 'The query is empty (only whitespace or comments).');
  }
  if (statements.length > 1) {
    throw new ExplorerError(
      'MULTIPLE_STATEMENTS',
      `Exactly one statement is allowed per call; found ${statements.length}. Remove the extra statements.`,
    );
  }

  const [statement] = statements as [ScannedStatement];
  const keyword = statement.firstWord?.toUpperCase();
  if (keyword === undefined || !ALLOWED_LEADING_KEYWORDS.has(keyword)) {
    const got = keyword === undefined ? 'a non-keyword token' : keyword;
    throw new ExplorerError(
      'NOT_SELECT',
      `Only read-only queries are allowed: a single SELECT or WITH ... SELECT statement. Got ${got}.`,
    );
  }

  return { sql: statement.text, leadingKeyword: keyword as 'SELECT' | 'WITH' };
}

/**
 * Splits SQL text on top-level semicolons. Statements consisting only of whitespace and comments
 * are dropped, so `SELECT 1; -- done` is one statement.
 */
export function scanStatements(sql: string): ScannedStatement[] {
  const statements: ScannedStatement[] = [];
  let start = 0;
  let hasContent = false;
  let firstWord: string | undefined;
  let i = 0;

  const flush = (end: number): void => {
    if (hasContent) {
      statements.push({ text: sql.slice(start, end).trim(), firstWord });
    }
    hasContent = false;
    firstWord = undefined;
  };

  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        throw new ExplorerError('UNTERMINATED_TOKEN', 'Unterminated /* block comment.');
      }
      i = end + 2;
      continue;
    }
    if (ch === ';') {
      flush(i);
      start = i + 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    hasContent = true;

    if (ch === "'") {
      i = skipQuoted(sql, i, "'", 'string literal');
      continue;
    }
    if (ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch, 'quoted identifier');
      continue;
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) {
        throw new ExplorerError('UNTERMINATED_TOKEN', 'Unterminated [bracketed] identifier.');
      }
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end] as string)) end += 1;
      // A blob literal X'00ff' starts like a word; its quoted part is skipped on the next pass.
      if (firstWord === undefined) firstWord = sql.slice(i, end);
      i = end;
      continue;
    }
    if (firstWord === undefined) firstWord = '';
    i += 1;
  }
  flush(sql.length);

  return statements.map((statement) => ({
    ...statement,
    firstWord: statement.firstWord === '' ? undefined : statement.firstWord,
  }));
}

/** Skips a quoted token where the quote character is escaped by doubling it (SQL style). */
function skipQuoted(sql: string, startIndex: number, quote: string, what: string): number {
  let i = startIndex + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new ExplorerError('UNTERMINATED_TOKEN', `Unterminated ${what}.`);
}

/** Quotes an identifier for SQLite. Only ever used on names that exist in the live schema. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
