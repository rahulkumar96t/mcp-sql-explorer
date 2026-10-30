/**
 * Child-process entry point. All SQLite work happens here so the parent can enforce a hard
 * query timeout with SIGKILL: SQLite's synchronous APIs give the parent no other way to stop a
 * runaway statement (a worker thread can be terminated only between JavaScript frames).
 *
 * argv: <database path>
 * Protocol: sends { type: 'ready' } (or { type: 'fatal' }) once, then answers each request.
 */
import type Database from 'better-sqlite3';
import { executeQuery, explainQuery, openReadOnlyDatabase, toExplorerError } from './connection.js';
import type { WorkerEvent, WorkerRequest, WorkerResponse } from './protocol.js';

function send(message: WorkerEvent | WorkerResponse, then?: () => void): void {
  process.send?.(message, undefined, {}, () => then?.());
}

function handle(db: Database.Database, request: WorkerRequest): WorkerResponse {
  try {
    const result =
      request.op === 'query'
        ? executeQuery(db, request.sql, request.params, request.limits)
        : explainQuery(db, request.sql, request.params);
    return { id: request.id, ok: true, result };
  } catch (error) {
    const failure = toExplorerError(error);
    return { id: request.id, ok: false, code: failure.code, message: failure.message };
  }
}

function main(): void {
  const [databasePath] = process.argv.slice(2);
  if (!databasePath || !process.send) {
    console.error('sql worker: must be started with fork(worker, [databasePath])');
    process.exit(2);
  }

  let db: Database.Database;
  try {
    db = openReadOnlyDatabase(databasePath);
  } catch (error) {
    send({ type: 'fatal', message: `Cannot open ${databasePath}: ${toExplorerError(error).message}` }, () =>
      process.exit(1),
    );
    return;
  }

  process.on('message', (request: WorkerRequest) => send(handle(db, request)));
  // The parent owns our lifetime: when it goes away (or closes the IPC channel), exit.
  process.on('disconnect', () => {
    db.close();
    process.exit(0);
  });
  send({ type: 'ready' });
}

main();
