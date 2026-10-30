import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildMusicStore } from './musicStore.js';

const target = resolve(process.argv[2] ?? 'data/music-store.db');
mkdirSync(dirname(target), { recursive: true });
rmSync(target, { force: true });

const started = performance.now();
const summary = buildMusicStore(target);
const elapsed = Math.round(performance.now() - started);

console.log(`Built ${target} in ${elapsed} ms`);
for (const [table, rows] of Object.entries(summary)) {
  console.log(`  ${table.padEnd(14)} ${rows}`);
}
