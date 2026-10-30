import { describe, expect, it } from 'vitest';
import { ExplorerError } from '../src/errors.js';
import { guardSelect, quoteIdentifier, scanStatements } from '../src/sql/guard.js';

function rejection(sql: string): string {
  try {
    guardSelect(sql);
  } catch (error) {
    expect(error).toBeInstanceOf(ExplorerError);
    return (error as ExplorerError).code;
  }
  throw new Error(`expected "${sql}" to be rejected`);
}

describe('guardSelect', () => {
  it.each([
    ['SELECT 1', 'SELECT'],
    ['select * from tracks', 'SELECT'],
    ['  \n\tSeLeCt 1', 'SELECT'],
    ['WITH t AS (SELECT 1 AS x) SELECT x FROM t', 'WITH'],
    ['with recursive n(x) as (select 1 union all select x + 1 from n limit 5) select x from n', 'WITH'],
    ['-- leading comment\nSELECT 1', 'SELECT'],
    ['/* block */ SELECT 1', 'SELECT'],
  ])('accepts %j', (sql, keyword) => {
    expect(guardSelect(sql).leadingKeyword).toBe(keyword);
  });

  it('strips a trailing semicolon and trailing comments', () => {
    expect(guardSelect('SELECT 1;').sql).toBe('SELECT 1');
    expect(guardSelect('SELECT 1; -- done\n').sql).toBe('SELECT 1');
    expect(guardSelect('SELECT 1 ; /* bye */ ;').sql).toBe('SELECT 1');
  });

  it('ignores semicolons and keywords inside literals, identifiers and comments', () => {
    expect(guardSelect("SELECT ';' AS semi, 'DROP TABLE x; --' AS s").leadingKeyword).toBe('SELECT');
    expect(guardSelect('SELECT "weird;name" FROM t').leadingKeyword).toBe('SELECT');
    expect(guardSelect('SELECT `a;b`, [c;d] FROM t').leadingKeyword).toBe('SELECT');
    expect(guardSelect("SELECT 'it''s; fine'").leadingKeyword).toBe('SELECT');
    expect(guardSelect('SELECT 1 -- ; DELETE FROM t').leadingKeyword).toBe('SELECT');
    expect(guardSelect('SELECT 1 /* ; DELETE FROM t */').leadingKeyword).toBe('SELECT');
    expect(guardSelect("SELECT X'00ff'").leadingKeyword).toBe('SELECT');
  });

  it.each(['', '   ', '-- only a comment', '/* nothing */', ';', ' ; ; '])('rejects empty input %j', (sql) => {
    expect(rejection(sql)).toBe('EMPTY_QUERY');
  });

  it.each([
    'SELECT 1; SELECT 2',
    'SELECT 1; DROP TABLE tracks',
    "SELECT ';'; DELETE FROM t",
    'SELECT 1;\n-- comment\nUPDATE t SET a = 1',
  ])('rejects multiple statements: %j', (sql) => {
    expect(rejection(sql)).toBe('MULTIPLE_STATEMENTS');
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'REPLACE INTO t VALUES (1)',
    'DROP TABLE t',
    'CREATE TABLE x (a)',
    'ALTER TABLE t ADD COLUMN b',
    'PRAGMA table_info(t)',
    "ATTACH DATABASE 'other.db' AS other",
    'DETACH other',
    'VACUUM',
    'BEGIN',
    'EXPLAIN SELECT 1',
    'VALUES (1)',
    '(SELECT 1)',
    '42',
  ])('rejects non-SELECT statement %j', (sql) => {
    expect(rejection(sql)).toBe('NOT_SELECT');
  });

  it.each(["SELECT 'abc", 'SELECT "abc', 'SELECT [abc', 'SELECT 1 /* open', 'SELECT `x'])(
    'rejects unterminated tokens in %j',
    (sql) => {
      expect(rejection(sql)).toBe('UNTERMINATED_TOKEN');
    },
  );

  it('produces readable messages that name the offending keyword', () => {
    expect(() => guardSelect('DELETE FROM t')).toThrow(/Got DELETE/);
  });
});

describe('scanStatements', () => {
  it('reports the first word of each statement', () => {
    expect(scanStatements('select 1; update t set a = 2').map((s) => s.firstWord)).toEqual(['select', 'update']);
  });
});

describe('quoteIdentifier', () => {
  it('wraps names in double quotes and doubles embedded quotes', () => {
    expect(quoteIdentifier('tracks')).toBe('"tracks"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier('a"; DROP TABLE t; --')).toBe('"a""; DROP TABLE t; --"');
  });
});
