import type { ErrorCode } from '../errors.js';

/** Values a caller may bind to `?` placeholders. Booleans are bound as 0/1. */
export type SqlParam = string | number | boolean | null;

/** A result cell after normalisation: blobs become a placeholder, big integers become strings. */
export type Cell = string | number | null;

export interface OutputLimits {
  /** Stop after this many rows and report `truncated: true`. */
  maxRows: number;
  /** Stop before the JSON-encoded rows exceed this many bytes. */
  maxOutputBytes: number;
  /** Text cells longer than this are cut and suffixed with a marker. */
  maxCellChars: number;
}

export type TruncationReason = 'max_rows' | 'max_output_bytes';

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  truncatedReason?: TruncationReason;
  elapsedMs: number;
}

export interface PlanStep {
  id: number;
  parent: number;
  detail: string;
}

export type WorkerRequest =
  | { id: number; op: 'query'; sql: string; params: SqlParam[]; limits: OutputLimits }
  | { id: number; op: 'explain'; sql: string; params: SqlParam[] };

export type WorkerResponse =
  | { id: number; ok: true; result: QueryResult | PlanStep[] }
  | { id: number; ok: false; code: ErrorCode; message: string };

/** Lifecycle messages: sent once, before any response. */
export type WorkerEvent = { type: 'ready' } | { type: 'fatal'; message: string };

export type WorkerMessage = WorkerResponse | WorkerEvent;
