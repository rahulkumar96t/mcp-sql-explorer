/**
 * Error codes surfaced to the MCP client. Every rejection carries a stable code so a model
 * (or a test) can tell "you asked for something unsafe" apart from "the SQL itself is wrong".
 */
export type ErrorCode =
  | 'EMPTY_QUERY'
  | 'MULTIPLE_STATEMENTS'
  | 'NOT_SELECT'
  | 'NOT_READ_ONLY'
  | 'UNTERMINATED_TOKEN'
  | 'UNKNOWN_TABLE'
  | 'UNKNOWN_COLUMN'
  | 'TIMEOUT'
  | 'SQL_ERROR'
  | 'WORKER_FAILURE';

export class ExplorerError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ExplorerError';
    this.code = code;
  }

  /** The text an MCP client sees: `[CODE] message`. */
  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function isExplorerError(value: unknown): value is ExplorerError {
  return value instanceof ExplorerError;
}
