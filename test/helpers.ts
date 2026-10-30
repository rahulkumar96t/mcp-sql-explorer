import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import Database from 'better-sqlite3';
import { DEFAULT_LIMITS, type ExplorerLimits } from '../src/config.js';
import { SqliteExecutor } from '../src/db/executor.js';
import { buildMusicStore } from '../src/demo/musicStore.js';
import { createExplorerServer } from '../src/server.js';

export interface TempDir {
  path: string;
  file(name: string): string;
  remove(): void;
}

export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), 'mcp-sql-explorer-'));
  return {
    path,
    file: (name) => join(path, name),
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Builds the demo music store into a fresh temp directory. */
export function demoDatabase(dir: TempDir): string {
  const file = dir.file('music-store.db');
  buildMusicStore(file, { seed: 7 });
  return file;
}

/** Creates a database from raw DDL/DML, for edge cases the demo data does not cover. */
export function customDatabase(dir: TempDir, name: string, sql: string): string {
  const file = dir.file(name);
  const db = new Database(file);
  db.exec(sql);
  db.close();
  return file;
}

export interface Harness {
  client: Client;
  executor: SqliteExecutor;
  close(): Promise<void>;
}

/** Wires a real server to a real client through the SDK's in-memory transport pair. */
export async function connect(databasePath: string, limits: Partial<ExplorerLimits> = {}): Promise<Harness> {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const executor = new SqliteExecutor({ databasePath, timeoutMs: merged.timeoutMs });
  const server = createExplorerServer({ executor, limits: merged });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    executor,
    close: async () => {
      await client.close();
      await server.close();
      await executor.close();
    },
  };
}

export interface ToolOutcome<T = Record<string, unknown>> {
  isError: boolean;
  text: string;
  structured: T;
}

export async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome<T>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n'),
    structured: (result.structuredContent ?? {}) as T,
  };
}

export interface QueryOutcome {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  rowCount: number;
  truncated: boolean;
  truncatedReason?: string;
}
