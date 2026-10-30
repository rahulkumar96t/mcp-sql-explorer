import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExplorerError } from '../errors.js';
import type {
  OutputLimits,
  PlanStep,
  QueryResult,
  SqlParam,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

export interface ExecutorOptions {
  databasePath: string;
  /** Wall-clock budget per statement. The worker process is killed when it is exceeded. */
  timeoutMs: number;
}

/** Distributes Omit over the request union so each variant keeps its own fields. */
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

/** How long a fresh worker may take to open the database and report ready. */
const STARTUP_TIMEOUT_MS = 15_000;

interface Worker {
  process: ChildProcess;
  /** Settles once the worker has opened the database (or failed to). */
  ready: Promise<void>;
}

interface InFlight {
  id: number;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Runs SQL in a dedicated child process, one statement at a time.
 *
 * - Requests are serialised; SQLite connections are single-threaded anyway, and serialising
 *   means a timeout only ever cancels the statement that caused it.
 * - The timeout clock starts when the statement is handed to a ready worker, so process
 *   start-up never counts against a query.
 * - On timeout the child is SIGKILLed and the request fails with TIMEOUT. The next request
 *   lazily starts a fresh child.
 * - The child is unref'd while idle, so an idle executor never keeps the process alive.
 */
export class SqliteExecutor {
  readonly databasePath: string;
  private readonly timeoutMs: number;
  private worker: Worker | undefined;
  private inFlight: InFlight | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;

  constructor(options: ExecutorOptions) {
    this.databasePath = resolve(options.databasePath);
    this.timeoutMs = options.timeoutMs;
    if (!existsSync(this.databasePath)) {
      throw new ExplorerError('WORKER_FAILURE', `Database file not found: ${this.databasePath}`);
    }
  }

  /** PID of the current worker process, if one is running (for diagnostics). */
  get workerPid(): number | undefined {
    return this.worker?.process.pid;
  }

  /** True while a statement is executing in the worker. */
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  query(sql: string, params: SqlParam[], limits: OutputLimits): Promise<QueryResult> {
    return this.enqueue({ op: 'query', sql, params, limits }) as Promise<QueryResult>;
  }

  explain(sql: string, params: SqlParam[]): Promise<PlanStep[]> {
    return this.enqueue({ op: 'explain', sql, params }) as Promise<PlanStep[]>;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.fail(new ExplorerError('WORKER_FAILURE', 'The executor was closed.'));
    this.killWorker();
  }

  private enqueue(body: RequestBody): Promise<unknown> {
    const task = this.queue.then(() => this.dispatch(body));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async dispatch(body: RequestBody): Promise<unknown> {
    if (this.closed) throw new ExplorerError('WORKER_FAILURE', 'The executor was closed.');

    const worker = this.worker?.process.connected ? this.worker : this.startWorker();
    try {
      await worker.ready;
    } catch (error) {
      if (this.worker === worker) this.worker = undefined;
      throw error;
    }
    const child = worker.process;

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(
          new ExplorerError(
            'TIMEOUT',
            `The query exceeded the ${this.timeoutMs} ms time limit and was cancelled. Add a LIMIT, a narrower WHERE clause or use explain_query to check the plan.`,
          ),
        );
        this.killWorker();
      }, this.timeoutMs);
      this.inFlight = { id, child, timer, resolve, reject };
      child.ref();
      child.channel?.ref();
      child.send({ id, ...body } satisfies WorkerRequest, (error) => {
        if (error) this.fail(new ExplorerError('WORKER_FAILURE', `Could not reach the query worker: ${error.message}`));
      });
    });
  }

  private startWorker(): Worker {
    const entry = workerEntry();
    const child = fork(entry.file, [this.databasePath], {
      execArgv: entry.execArgv,
      // stdout is ignored on purpose: in stdio mode it carries the MCP protocol.
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new ExplorerError('WORKER_FAILURE', `The query worker did not start within ${STARTUP_TIMEOUT_MS} ms.`));
        child.kill('SIGKILL');
      }, STARTUP_TIMEOUT_MS);
      const settle = (error?: ExplorerError) => {
        clearTimeout(timer);
        child.off('message', onEvent);
        child.off('exit', onEarlyExit);
        if (error) rejectReady(error);
        else resolveReady();
      };
      const onEvent = (message: WorkerMessage) => {
        if (!('type' in message)) return;
        settle(message.type === 'ready' ? undefined : new ExplorerError('WORKER_FAILURE', message.message));
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) =>
        settle(new ExplorerError('WORKER_FAILURE', `The query worker exited during start-up (code ${code}, signal ${signal}).`));
      child.on('message', onEvent);
      child.on('exit', onEarlyExit);
    });
    // Callers observe failures through dispatch(); avoid an unhandled rejection meanwhile.
    ready.catch(() => undefined);

    child.on('message', (message: WorkerMessage) => {
      if ('id' in message) this.onResponse(child, message);
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', (error) => {
      if (this.inFlight?.child === child) {
        this.fail(new ExplorerError('WORKER_FAILURE', `Query worker error: ${error.message}`));
      }
    });

    const worker = { process: child, ready };
    this.worker = worker;
    return worker;
  }

  private onResponse(child: ChildProcess, message: WorkerResponse): void {
    const pending = this.inFlight;
    if (!pending || pending.child !== child || pending.id !== message.id) return;
    this.inFlight = undefined;
    clearTimeout(pending.timer);
    this.idle(child);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new ExplorerError(message.code, message.message));
    }
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.worker?.process === child) this.worker = undefined;
    if (this.inFlight?.child === child) {
      this.fail(
        new ExplorerError('WORKER_FAILURE', `The query worker exited unexpectedly (code ${code}, signal ${signal}).`),
      );
    }
  }

  private fail(error: ExplorerError): void {
    const pending = this.inFlight;
    if (!pending) return;
    this.inFlight = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private killWorker(): void {
    const child = this.worker?.process;
    this.worker = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  private idle(child: ChildProcess): void {
    child.unref();
    child.channel?.unref();
  }
}

/**
 * Locates the worker script next to this module. When running from TypeScript sources
 * (tests, `tsx`), the child needs the tsx loader; the compiled build runs on plain Node.
 */
function workerEntry(): { file: string; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) {
    return { file: join(dirname(here), 'worker.ts'), execArgv: ['--import', 'tsx'] };
  }
  return { file: join(dirname(here), 'worker.js'), execArgv: [] };
}
