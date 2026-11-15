import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { testRedisUrl, waitFor } from './env';
import type { LogLine } from './harness';

const ENTRY = resolve(__dirname, '../../dist/main.js');

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The real worker: `node dist/main.js` in its own OS process, configured only through environment variables, exactly as an
 * operator would run it. Used to verify what in-process tests cannot: exit codes, real signals, a hard kill.
 */
export class WorkerProcess {
  readonly logs: LogLine[] = [];
  stderr = '';
  readonly exited: Promise<ExitInfo>;
  private exit?: ExitInfo;
  private readonly child: ChildProcess;
  private buffered = '';

  /**
   * `entry` runs a different file instead of the built worker (a TypeScript test entry through tsx); everything else about the
   * process (environment-only configuration, pipes, signals) is identical.
   */
  constructor(env: Record<string, string>, options: { entry?: string } = {}) {
    const entry = options.entry ?? ENTRY;
    if (options.entry === undefined && !existsSync(ENTRY)) {
      throw new Error(
        'apps/worker/dist/main.js is missing: build first (`pnpm --filter @agentos/worker build`, or run via Nx).',
      );
    }
    this.child = spawn(process.execPath, options.entry === undefined ? [entry] : ['--import', 'tsx', entry], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', REDIS_URL: testRedisUrl(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8').on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
    this.exited = new Promise((resolveExit) => {
      this.child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolveExit(this.exit);
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exit !== undefined;
  }

  /** Everything the process printed, for "no secret was printed" assertions. */
  get output(): string {
    return `${JSON.stringify(this.logs)}\n${this.stderr}`;
  }

  hasLog(message: string): boolean {
    return this.logs.some((line) => line.msg.startsWith(message));
  }

  waitForLog(message: string, timeoutMs = 20_000): Promise<LogLine> {
    return waitFor(() => this.logs.find((line) => line.msg.startsWith(message)), {
      timeoutMs,
      message: `log "${message}" (exited: ${JSON.stringify(this.exit)}, stderr: ${this.stderr.slice(0, 300)})`,
    });
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  /** Test cleanup: never leave a worker running. */
  async kill(): Promise<void> {
    if (!this.hasExited) this.child.kill('SIGKILL');
    await this.exited;
  }

  private onStdout(chunk: string): void {
    this.buffered += chunk;
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.logs.push(JSON.parse(line) as LogLine);
      } catch {
        this.stderr += `[non-json stdout] ${line}\n`;
      }
    }
  }
}
