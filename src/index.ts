#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, parseConfig, USAGE } from './config.js';
import { SqliteExecutor } from './db/executor.js';
import { isExplorerError } from './errors.js';
import { createExplorerServer, SERVER_NAME } from './server.js';

// stdout carries the MCP protocol; everything human-readable goes to stderr.
const log = (message: string): void => console.error(`[${SERVER_NAME}] ${message}`);

function main(): void {
  let config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (error) {
    const message = error instanceof ConfigError || error instanceof TypeError ? error.message : String(error);
    console.error(`${message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (config === 'help') {
    console.error(USAGE);
    return;
  }

  let executor: SqliteExecutor;
  try {
    executor = new SqliteExecutor({
      databasePath: config.databasePath,
      timeoutMs: config.limits.timeoutMs,
    });
  } catch (error) {
    log(isExplorerError(error) ? error.message : String(error));
    process.exit(1);
  }

  const handle = serveStdio(() => createExplorerServer({ executor, limits: config.limits }), {
    onerror: (error) => log(`transport error: ${error.message}`),
  });
  log(`serving ${executor.databasePath} read-only on stdio`);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: shutting down`);
    void Promise.allSettled([handle.close(), executor.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main();
