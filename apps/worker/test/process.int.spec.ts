import { systemPingJob } from '@agentos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from './support/env';
import { Harness } from './support/harness';
import { WorkerProcess } from './support/worker-process';

/*
 * The ACTUAL worker process (`node dist/main.js`), configured only through environment variables, against real Redis.
 * Verifies exit codes, real signals and a hard kill, which an in-process test cannot.
 *
 * Node on Windows cannot deliver SIGTERM/SIGINT to a child (kill() terminates it instantly), so the signal tests run only on
 * POSIX (Linux CI, or the Linux container used for local verification: see docs/architecture/workers.md). The invalid-config,
 * startup-failure and SIGKILL tests run everywhere.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let h: Harness;
const started: WorkerProcess[] = [];

beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((p) => p.kill()));
  await h.close();
});

function launch(env: Record<string, string> = {}): WorkerProcess {
  const worker = new WorkerProcess({
    QUEUE_PREFIX: h.prefix,
    WORKER_NAME: 'proc-worker',
    WORKER_LOCK_DURATION_MS: '1000',
    WORKER_STARTUP_TIMEOUT_MS: '5000',
    ...env,
  });
  started.push(worker);
  return worker;
}

async function launchReady(env: Record<string, string> = {}): Promise<WorkerProcess> {
  const worker = launch(env);
  await worker.waitForLog('worker ready');
  return worker;
}

const ping = (delayMs: number, correlationId?: string) =>
  h.producer.enqueue(systemPingJob, { delayMs }, correlationId ? { correlationId } : {});
const untilState = (jobId: string, expected: string) =>
  waitFor(async () => (await h.jobState(jobId)) === expected, { message: `job ${jobId} to be ${expected}` });

describe('startup', () => {
  it('exits with code 2 and names the variable (not its value) when the configuration is invalid', async () => {
    const worker = launch({ REDIS_URL: 'not-a-url-containing-secret-xyz', WORKER_CONCURRENCY: '0' });
    const exit = await worker.exited;

    expect(exit.code).toBe(2);
    expect(worker.stderr).toContain('REDIS_URL');
    expect(worker.stderr).toContain('WORKER_CONCURRENCY');
    expect(worker.output).not.toContain('secret-xyz');
    expect(worker.logs).toHaveLength(0); // nothing was started
  });

  it('exits with code 1 when Redis is not reachable, without printing the credentials', async () => {
    const worker = launch({
      REDIS_URL: 'redis://:hunter2-password@127.0.0.1:1/15',
      WORKER_STARTUP_TIMEOUT_MS: '1000',
    });
    const exit = await worker.exited;

    expect(exit.code).toBe(1);
    expect(worker.logs.find((l) => l.msg === 'worker failed to start')).toBeDefined();
    expect(worker.output).not.toContain('hunter2-password');
  });

  it('starts, reports itself ready, and processes a job end to end with the correlation id preserved', async () => {
    const worker = await launchReady();
    const ready = worker.logs.find((l) => l.msg === 'worker ready');
    expect(ready).toMatchObject({ queues: ['system'], worker: 'proc-worker' });
    expect(JSON.stringify(ready)).not.toMatch(/:\/\/[^@/]*:[^@/]*@/); // no credentials in the URL it prints

    const { jobId } = await ping(0, 'it-corr-77');
    await untilState(jobId, 'completed');
    expect(worker.logs.find((l) => l.msg === 'job completed' && l.jobId === jobId)).toMatchObject({
      correlationId: 'it-corr-77',
      jobType: 'system.ping',
      queue: 'system',
    });
  });
});

posixOnly('graceful shutdown by real signals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s while idle: exits 0 promptly', async (signal) => {
    const worker = await launchReady();
    worker.signal(signal);
    const exit = await worker.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(worker.logs.find((l) => l.msg.startsWith('shutdown started'))).toMatchObject({ reason: signal });
    expect(worker.hasLog('shutdown complete: all active jobs finished')).toBe(true);
  });

  it('SIGTERM during a job: lets it finish, acknowledges it, then exits 0', async () => {
    const worker = await launchReady({ WORKER_SHUTDOWN_GRACE_MS: '20000' });
    const { jobId } = await ping(2_500);
    await worker.waitForLog('worker ready');
    await waitFor(async () => (await h.jobState(jobId)) === 'active', { message: 'job to become active' });

    worker.signal('SIGTERM');
    const exit = await worker.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(await h.jobState(jobId)).toBe('completed'); // the in-flight job was finished, not dropped
    expect(worker.hasLog('system.ping handled')).toBe(true);
  });

  it('SIGTERM when the grace period is too short: exits 1 and leaves the job unacknowledged for redelivery', async () => {
    const worker = await launchReady({ WORKER_SHUTDOWN_GRACE_MS: '300' });
    const { jobId } = await ping(3_000); // longer than the 300 ms grace period
    await waitFor(async () => (await h.jobState(jobId)) === 'active', { message: 'job to become active' });

    worker.signal('SIGTERM');
    const exit = await worker.exited;

    expect(exit).toEqual({ code: 1, signal: null });
    expect(worker.logs.find((l) => l.msg === 'shutdown complete (forced)')).toMatchObject({
      forced: true,
      abandonedJobs: 1,
    });
    expect(await h.jobState(jobId)).toBe('active'); // neither completed nor failed
    expect(worker.hasLog('system.ping handled')).toBe(false);

    // Another worker recovers it once the lock has expired and runs it to completion.
    const second = await launchReady({ WORKER_NAME: 'proc-worker-2' });
    await untilState(jobId, 'completed');
    expect(second.hasLog('system.ping handled')).toBe(true);
  });

  it('a second signal during shutdown exits immediately with code 1', async () => {
    const worker = await launchReady({ WORKER_SHUTDOWN_GRACE_MS: '60000' });
    const { jobId } = await ping(30_000);
    await waitFor(async () => (await h.jobState(jobId)) === 'active', { message: 'job to become active' });

    worker.signal('SIGTERM');
    await worker.waitForLog('shutdown started');
    worker.signal('SIGINT');
    const exit = await worker.exited;

    expect(exit.code).toBe(1);
    expect(worker.hasLog('second signal received')).toBe(true);
    expect(await h.jobState(jobId)).toBe('active'); // still not acknowledged
  });
});

describe('recovery after an interruption', () => {
  it('a hard-killed worker (SIGKILL, no cleanup at all) loses no job: another worker finishes it after the lock expires', async () => {
    const worker = await launchReady();
    const { jobId } = await ping(1_500);
    await waitFor(async () => (await h.jobState(jobId)) === 'active', { message: 'job to become active' });

    worker.signal('SIGKILL');
    await worker.exited;
    expect(await h.jobState(jobId)).toBe('active'); // abandoned mid-flight, nobody to acknowledge it

    await launchReady({ WORKER_NAME: 'proc-worker-2' });
    await untilState(jobId, 'completed');
  });
});
