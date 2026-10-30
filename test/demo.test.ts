import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { buildMusicStore, createRandom } from '../src/demo/musicStore.js';
import { tempDir } from './helpers.js';

const dir = tempDir();

afterAll(() => dir.remove());

function contentDigest(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const tables = ['artists', 'albums', 'tracks', 'customers', 'invoices', 'invoice_lines'];
    return tables
      .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()))
      .join('|');
  } finally {
    db.close();
  }
}

describe('demo music store', () => {
  it('is deterministic for a given seed', () => {
    const a = dir.file('a.db');
    const b = dir.file('b.db');
    const c = dir.file('c.db');
    expect(buildMusicStore(a, { seed: 1 })).toEqual(buildMusicStore(b, { seed: 1 }));
    buildMusicStore(c, { seed: 2 });
    expect(contentDigest(a)).toBe(contentDigest(b));
    expect(contentDigest(a)).not.toBe(contentDigest(c));
  });

  it('honours size options and keeps referential integrity', () => {
    const path = dir.file('small.db');
    const summary = buildMusicStore(path, { artists: 5, customers: 20, invoices: 50 });
    expect(summary).toMatchObject({ genres: 10, artists: 5, customers: 20, invoices: 50 });

    const db = new Database(path, { readonly: true });
    try {
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      const mismatched = db
        .prepare(
          `SELECT count(*) AS n FROM invoices AS i
            WHERE i.total_cents <> (SELECT sum(unit_price_cents * quantity) FROM invoice_lines WHERE invoice_id = i.invoice_id)`,
        )
        .get() as { n: number };
      expect(mismatched.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('uses a reproducible PRNG', () => {
    const first = createRandom(42);
    const second = createRandom(42);
    const values = Array.from({ length: 5 }, () => first());
    expect(Array.from({ length: 5 }, () => second())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
