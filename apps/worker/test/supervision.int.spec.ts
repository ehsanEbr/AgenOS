import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { systemPingJob } from '@agentos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthSnapshot } from '../src/health';
import { waitFor } from './support/env';
import { Harness } from './support/harness';
import { stuckJob } from './support/stuck-job';
import { WorkerProcess } from './support/worker-process';

/*
 * What a SUPERVISOR (Docker, systemd, a developer's shell) can observe about the real worker process: exit codes, the health
 * heartbeat, and the behavior of the abort-grace path in the real entry point. Against real Redis; no sleeps: every wait is on
 * a log line, a Redis job state, a file's content or the process exit.
 *
 * The signal-based test is POSIX-only (Node on Windows cannot deliver SIGTERM); everything else runs on both.
 */
const posixOnly = process.platform === 'win32' ? it.skip : it;
const STUCK_ENTRY = resolve(__dirname, 'support/stuck-main.ts');
const HEALTHCHECK = resolve(__dirname, '../dist/healthcheck.js');

let h: Harness;
let dir: string;
const started: WorkerProcess[] = [];

beforeEach(() => {
  h = new Harness();
  dir = mkdtempSync(join(tmpdir(), 'agentos-supervision-'));
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((p) => p.kill()));
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseEnv = () => ({
  QUEUE_PREFIX: h.prefix,
  WORKER_NAME: 'supervised',
  WORKER_LOCK_DURATION_MS: '1000',
  WORKER_STARTUP_TIMEOUT_MS: '5000',
});

function launch(env: Record<string, string>, entry?: string): WorkerProcess {
  const worker = new WorkerProcess({ ...baseEnv(), ...env }, entry === undefined ? {} : { entry });
  started.push(worker);
  return worker;
}

const untilState = (jobId: string, expected: string) =>
  waitFor(async () => (await h.jobState(jobId)) === expected, { message: `job ${jobId} to be ${expected}` });

const healthcheck = (file: string) => {
  const result = spawnSync(process.execPath, [HEALTHCHECK], {
    env: { ...process.env, WORKER_HEALTH_FILE: file },
    encoding: 'utf8',
  });
  return { code: result.status, output: result.stdout.trim() };
};
const readSnapshot = (file: string): HealthSnapshot | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HealthSnapshot;
  } catch {
    return undefined;
  }
};

describe('timeouts in the real worker process', () => {
  it('a COOPERATIVE handler that times out is aborted and retried as documented; the worker keeps running', async () => {
    const worker = launch({ WORKER_JOB_TIMEOUT_MS: '1000' });
    await worker.waitForLog('worker ready');
    // system.ping honors its AbortSignal, so a 30 s ping times out after 1 s on every attempt.
    const { jobId } = await h.producer.enqueue(
      systemPingJob,
      { delayMs: 30_000 },
      { retry: { attempts: 2, backoffMs: 100, jitter: 0 } },
    );
    await untilState(jobId, 'failed');

    const timeouts = worker.logs.filter((l) => l.jobId === jobId && l.failureClass === 'timeout');
    expect(timeouts.map((l) => l.willRetry)).toEqual([true, false]);
    expect(timeouts.every((l) => l.lateOutcome === 'rejected')).toBe(true); // it stopped promptly when told to
    expect(worker.hasLog('handler ignored its abort signal')).toBe(false); // so the stuck-handler path was not taken
    expect(worker.hasExited).toBe(false); // and the process was not restarted
  });

  it('a NON-COOPERATIVE async handler triggers the abort-grace path: the real entry point shuts down and exits 1, holding the job', async () => {
    const worker = launch(
      { WORKER_JOB_TIMEOUT_MS: '1000', WORKER_ABORT_GRACE_MS: '200', WORKER_SHUTDOWN_GRACE_MS: '500' },
      STUCK_ENTRY,
    );
    await worker.waitForLog('worker ready');
    const { jobId } = await h.producer.enqueue(
      stuckJob,
      {},
      { retry: { attempts: 3, backoffMs: 100, jitter: 0 } },
    );

    const exit = await worker.exited;
    expect(exit.code).toBe(1); // non-zero: a supervisor restarts the process
    expect(worker.hasLog('handler ignored its abort signal')).toBe(true);
    expect(worker.logs.find((l) => l.msg.startsWith('a handler is stuck'))?.level).toBe(60); // fatal
    expect(worker.logs.find((l) => l.msg === 'shutdown complete (forced)')).toMatchObject({
      forced: true,
      abandonedJobs: 1,
    });

    // The Phase 1.5 guarantee holds end to end: the handler ran once (never overlapped by a retry) and the job was not
    // acknowledged or failed: it stays active and is redelivered to the next worker after its lock expires.
    expect(worker.logs.filter((l) => l.msg === 'stuck handler started')).toHaveLength(1);
    expect(await h.jobState(jobId)).toBe('active');
  });
});

describe('the health heartbeat as a supervisor sees it', () => {
  it('reports ready while running; after a hard kill the leftover file is NOT mistaken for a healthy worker', async () => {
    const file = join(dir, 'health.json');
    expect(healthcheck(file)).toMatchObject({ code: 1, output: expect.stringContaining('no health file') });

    const worker = launch({ WORKER_HEALTH_FILE: file });
    await worker.waitForLog('worker ready');
    await waitFor(() => readSnapshot(file)?.ready === true, { message: 'health file to report ready' });
    expect(readSnapshot(file)).toMatchObject({
      pid: worker.pid,
      state: 'running',
      ready: true,
      redis: 'ready',
    });
    expect(healthcheck(file)).toMatchObject({ code: 0, output: 'healthy: ready' });

    worker.signal('SIGKILL'); // a crash: no chance to clean up, the file stays behind saying "ready"
    await worker.exited;
    expect(existsSync(file)).toBe(true);
    expect(readSnapshot(file)?.ready).toBe(true); // stale evidence...
    expect(healthcheck(file)).toMatchObject({ code: 1, output: expect.stringContaining('not running') }); // ...which is not trusted
  });

  posixOnly('stops reporting ready the moment shutdown begins, and removes the file at exit', async () => {
    const file = join(dir, 'health.json');
    const worker = launch({ WORKER_HEALTH_FILE: file, WORKER_SHUTDOWN_GRACE_MS: '20000' });
    await worker.waitForLog('worker ready');
    await waitFor(() => readSnapshot(file)?.ready === true, { message: 'health file to report ready' });
    // Long enough that the process is certainly still draining (not finished) when we look at the file.
    const { jobId } = await h.producer.enqueue(systemPingJob, { delayMs: 6_000 });
    await waitFor(async () => (await h.jobState(jobId)) === 'active', { message: 'job to become active' });

    // No need to wait for a heartbeat tick: shutdown rewrites the file synchronously, whatever the interval.
    worker.signal('SIGTERM');
    // The job still has seconds to run, so the process is alive and draining: it must already say "not ready".
    await waitFor(() => readSnapshot(file)?.state === 'draining', {
      message: 'health file to show draining',
    });
    expect(readSnapshot(file)).toMatchObject({ ready: false, pid: worker.pid });
    expect(healthcheck(file)).toMatchObject({ code: 1, output: expect.stringContaining('state=draining') });

    expect(await worker.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(file)).toBe(false);
    expect(await h.jobState(jobId)).toBe('completed');
  });
});
