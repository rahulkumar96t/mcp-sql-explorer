import { ExplorerError } from '../errors.js';
import { quoteIdentifier } from '../sql/guard.js';
import type { SqliteExecutor } from './executor.js';
import type { Cell, OutputLimits } from './protocol.js';

export interface TableSummary {
  name: string;
  type: 'table' | 'view';
  columnCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  /** 1-based position in the primary key, or 0 when the column is not part of it. */
  primaryKeyPosition: number;
}

export interface ForeignKeyInfo {
  columns: string[];
  referencesTable: string;
  referencesColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  origin: 'create_index' | 'unique_constraint' | 'primary_key';
  partial: boolean;
  columns: string[];
}

export interface TableDescription {
  name: string;
  type: 'table' | 'view';
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  /** null when counting did not finish within the query timeout. */
  rowCount: number | null;
  sql: string | null;
}

/** Internal catalog queries are trusted and small; they only need generous limits. */
const CATALOG_LIMITS: OutputLimits = { maxRows: 100_000, maxOutputBytes: 32 * 1024 * 1024, maxCellChars: 1_000_000 };

const INDEX_ORIGINS: Record<string, IndexInfo['origin']> = {
  c: 'create_index',
  u: 'unique_constraint',
  pk: 'primary_key',
};

/**
 * Schema introspection. Every identifier that reaches dynamic SQL is first resolved against
 * `sqlite_schema`, then quoted; catalog lookups themselves use bound parameters.
 */
export class SchemaCatalog {
  constructor(private readonly executor: SqliteExecutor) {}

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.rows(
      `SELECT m.name, m.type, (SELECT count(*) FROM pragma_table_info(m.name)) AS column_count
         FROM sqlite_schema AS m
        WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY m.name`,
    );
    return rows.map(([name, type, columnCount]) => ({
      name: String(name),
      type: type === 'view' ? 'view' : 'table',
      columnCount: Number(columnCount),
    }));
  }

  /**
   * Resolves a caller-supplied table name to the real one: exact match first, then a unique
   * case-insensitive match (SQLite identifiers are case-insensitive).
   */
  async resolveTable(name: string): Promise<TableSummary> {
    const tables = await this.listTables();
    const exact = tables.find((table) => table.name === name);
    if (exact) return exact;
    const folded = tables.filter((table) => table.name.toLowerCase() === name.toLowerCase());
    if (folded.length === 1) return folded[0] as TableSummary;

    const known = tables.map((table) => table.name);
    const preview = known.slice(0, 50).join(', ') + (known.length > 50 ? ', ...' : '');
    throw new ExplorerError('UNKNOWN_TABLE', `No table or view named "${name}". Known tables: ${preview || '(none)'}.`);
  }

  async columns(table: string): Promise<ColumnInfo[]> {
    const rows = await this.rows('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid', [
      table,
    ]);
    return rows.map(([name, type, notNull, defaultValue, pk]) => ({
      name: String(name),
      type: String(type ?? ''),
      notNull: Number(notNull) === 1,
      defaultValue: defaultValue === null ? null : String(defaultValue),
      primaryKeyPosition: Number(pk),
    }));
  }

  /** Resolves column names against the table, returning the real (correctly cased) names. */
  async resolveColumns(table: string, requested: string[]): Promise<string[]> {
    const columns = (await this.columns(table)).map((column) => column.name);
    return requested.map((name) => {
      const match =
        columns.find((column) => column === name) ??
        columns.find((column) => column.toLowerCase() === name.toLowerCase());
      if (!match) {
        throw new ExplorerError(
          'UNKNOWN_COLUMN',
          `Table "${table}" has no column "${name}". Columns: ${columns.join(', ')}.`,
        );
      }
      return match;
    });
  }

  async describeTable(name: string): Promise<TableDescription> {
    const table = await this.resolveTable(name);
    const columns = await this.columns(table.name);
    const primaryKey = columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((column) => column.name);

    const [foreignKeys, indexes, rowCount, sql] = await Promise.all([
      this.foreignKeys(table.name),
      this.indexes(table.name),
      this.rowCount(table.name),
      this.definition(table.name),
    ]);

    return { name: table.name, type: table.type, columns, primaryKey, foreignKeys, indexes, rowCount, sql };
  }

  /** CREATE statements for every user table, view, index and trigger. */
  async schemaSql(): Promise<string> {
    const rows = await this.rows(
      `SELECT type, name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`,
    );
    return rows.map(([type, name, sql]) => `-- ${String(type)}: ${String(name)}\n${String(sql)};`).join('\n\n');
  }

  private async foreignKeys(table: string): Promise<ForeignKeyInfo[]> {
    const rows = await this.rows(
      'SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      [table],
    );
    const byId = new Map<number, ForeignKeyInfo>();
    for (const [id, , referencesTable, from, to, onUpdate, onDelete] of rows) {
      const key = Number(id);
      let fk = byId.get(key);
      if (!fk) {
        fk = {
          columns: [],
          referencesTable: String(referencesTable),
          referencesColumns: [],
          onUpdate: String(onUpdate),
          onDelete: String(onDelete),
        };
        byId.set(key, fk);
      }
      fk.columns.push(String(from));
      // `to` is NULL when the reference targets the parent's primary key implicitly.
      if (to !== null) fk.referencesColumns.push(String(to));
    }
    return [...byId.values()];
  }

  private async indexes(table: string): Promise<IndexInfo[]> {
    const list = await this.rows('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name', [
      table,
    ]);
    const indexes: IndexInfo[] = [];
    for (const [name, unique, origin, partial] of list) {
      const columns = await this.rows('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [String(name)]);
      indexes.push({
        name: String(name),
        unique: Number(unique) === 1,
        origin: INDEX_ORIGINS[String(origin)] ?? 'create_index',
        partial: Number(partial) === 1,
        // Expression indexes report NULL column names.
        columns: columns.map(([column]) => (column === null ? '<expression>' : String(column))),
      });
    }
    return indexes;
  }

  private async rowCount(table: string): Promise<number | null> {
    try {
      const [row] = await this.rows(`SELECT count(*) FROM ${quoteIdentifier(table)}`);
      return Number(row?.[0] ?? 0);
    } catch (error) {
      // A full count of a very large table may exceed the timeout; the rest is still useful.
      if (error instanceof ExplorerError && error.code === 'TIMEOUT') return null;
      throw error;
    }
  }

  private async definition(table: string): Promise<string | null> {
    const [row] = await this.rows("SELECT sql FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')", [table]);
    return row?.[0] === null || row?.[0] === undefined ? null : String(row[0]);
  }

  private async rows(sql: string, params: (string | number)[] = []): Promise<Cell[][]> {
    const result = await this.executor.query(sql, params, CATALOG_LIMITS);
    return result.rows;
  }
}
