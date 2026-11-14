import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StartupError } from '../src/runtime';
import { RedisProxy } from './support/redis-proxy';
import { testRedisUrl, waitFor } from './support/env';
import { FAST_RETRY, Harness } from './support/harness';
import { testJobs } from './support/test-processors';

/*
 * The worker runtime against a REAL Redis (`pnpm infra:up`). Every test has its own queue prefix. Tests synchronize on
 * conditions (job state in Redis, events from the handlers, log lines), never on fixed sleeps.
 */

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.close();
});

const untilState = (jobId: string, expected: string) =>
  waitFor(async () => (await h.jobState(jobId)) === expected, { message: `job ${jobId} to be ${expected}` });

describe('processing', () => {
  it('runs a submitted job to completion and keeps the correlation id across the boundary', async () => {
    const host = await h.startHost();
    expect(host.isReady).toBe(true);
    expect(host.state).toBe('running');

    const { jobId, correlationId } = await h.producer.enqueue(
      testJobs.succeed,
      { note: 'TOP-SECRET-PAYLOAD' },
      { correlationId: 'req-abc-123' },
    );
    expect(correlationId).toBe('req-abc-123');
    await untilState(jobId, 'completed');

    expect(h.controls.executionsOf(jobId)).toEqual([
      { type: 'test.succeed', jobId, attempt: 1, correlationId: 'req-abc-123' },
    ]);

    const done = h.logsWhere((l) => l.msg === 'job completed' && l.jobId === jobId);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      worker: 'test',
      queue: 'system',
      jobType: 'test.succeed',
      jobVersion: 1,
      correlationId: 'req-abc-123',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(typeof done[0]?.durationMs).toBe('number');
  });

  it('never writes job payloads or Redis credentials to the logs', async () => {
    const host = await h.startHost();
    const { jobId } = await h.producer.enqueue(testJobs.succeed, { note: 'TOP-SECRET-PAYLOAD' });
    await untilState(jobId, 'completed');
    await host.stop('test');

    const logs = h.capture.text();
    expect(logs).not.toContain('TOP-SECRET-PAYLOAD');
    const password = new URL(testRedisUrl()).password;
    if (password) expect(logs).not.toContain(password);
  });

  it('processes up to `concurrency` jobs at once and starts the next one as soon as a slot frees', async () => {
    await h.startHost({ concurrency: 2 });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await h.producer.enqueue(testJobs.hold, {})).jobId);
    const [a, b, c] = ids as [string, string, string];

    await h.controls.startedSignal(a).promise;
    await h.controls.startedSignal(b).promise;
    expect(h.controls.executionsOf(c)).toHaveLength(0); // the third job waits for a free slot
    expect(await h.jobState(c)).toBe('waiting');

    h.controls.releaseSignal(a).resolve();
    await h.controls.startedSignal(c).promise; // a slot freed -> the third job starts
    h.controls.releaseSignal(b).resolve();
    h.controls.releaseSignal(c).resolve();
    await Promise.all(ids.map((id) => untilState(id, 'completed')));
  });
});

describe('failure handling and retries', () => {
  it('retries a transient failure and then completes the job', async () => {
    await h.startHost();
    const { jobId } = await h.producer.enqueue(testJobs.flaky, { failTimes: 1 }, { retry: FAST_RETRY });
    await untilState(jobId, 'completed');

    expect(h.controls.executionsOf(jobId).map((e) => e.attempt)).toEqual([1, 2]);
    const retried = h.logsWhere(
      (l) => l.jobId === jobId && l.msg === 'job attempt failed; it will be retried',
    );
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      failureClass: 'transient',
      reason: 'handler_error',
      willRetry: true,
      attempt: 1,
    });
  });

  it('stops after the configured attempts and keeps the exhausted job inspectable', async () => {
    await h.startHost();
    const { jobId, correlationId } = await h.producer.enqueue(testJobs.failAlways, {}, { retry: FAST_RETRY });
    await untilState(jobId, 'failed');

    // exactly `attempts` executions: no retry storm, no infinite loop
    expect(h.controls.executionsOf(jobId).map((e) => e.attempt)).toEqual([1, 2, 3]);

    const failed = await h.producer.failedJobs('system');
    expect(failed).toEqual([
      expect.objectContaining({
        jobId,
        type: 'test.fail_always',
        attemptsMade: 3,
        correlationId,
        failedReason: expect.stringContaining('handler_error'),
      }),
    ]);
    const final = h.logsWhere((l) => l.jobId === jobId && l.msg === 'job failed permanently');
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ failureClass: 'transient', willRetry: false, attempt: 3 });
  });

  it('does not retry a permanent failure', async () => {
    await h.startHost();
    const { jobId } = await h.producer.enqueue(testJobs.permanent, {}, { retry: FAST_RETRY });
    await untilState(jobId, 'failed');

    expect(h.controls.executionsOf(jobId)).toHaveLength(1);
    const [info] = await h.producer.failedJobs('system');
    expect(info).toMatchObject({ jobId, attemptsMade: 1 });
    expect(h.logsWhere((l) => l.jobId === jobId && l.msg === 'job failed permanently')[0]).toMatchObject({
      failureClass: 'permanent',
      reason: 'handler_permanent_error',
    });
  });

  // Timeouts (a handler that respects its signal, one that ignores it, late results, shutdown) are covered in timeout.int.spec.ts.

  it('keeps processing other jobs while one job fails repeatedly', async () => {
    await h.startHost();
    const bad = await h.producer.enqueue(testJobs.failAlways, {}, { retry: FAST_RETRY });
    const good = [];
    for (let i = 0; i < 5; i++) good.push((await h.producer.enqueue(testJobs.succeed, {})).jobId);

    await Promise.all(good.map((id) => untilState(id, 'completed')));
    await untilState(bad.jobId, 'failed');
  });
});

describe('malformed jobs', () => {
  const rawEnvelope = (overrides: Record<string, unknown>) => ({
    type: 'test.succeed',
    version: 1,
    correlationId: 'raw-1',
    createdAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  });

  it.each([
    ['not an envelope at all', { garbage: true }, 'invalid_envelope'],
    ['a string instead of an object', 'just a string', 'invalid_envelope'],
    ['a type that has no processor', rawEnvelope({ type: 'nothing.registered' }), 'unknown_type'],
    ['a version the worker does not support', rawEnvelope({ version: 99 }), 'unsupported_version'],
    [
      'a payload that fails the processor contract',
      rawEnvelope({ type: 'test.flaky', payload: { failTimes: 'many' } }),
      'invalid_payload',
    ],
  ])('fails %s safely, without retries, and the worker keeps running', async (_name, data, reason) => {
    const host = await h.startHost();
    // Bypass the producer: this is what a buggy or older producer could put in Redis.
    const bad = await h.queue.add('anything', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 100 },
    });
    const badId = String(bad.id);
    await untilState(badId, 'failed');

    const failure = h.logsWhere((l) => l.jobId === badId && l.msg === 'job failed permanently');
    expect(failure).toHaveLength(1);
    expect(failure[0]).toMatchObject({ failureClass: 'permanent', reason, attempt: 1 });
    expect((await h.queue.getJob(badId))?.attemptsMade).toBe(1); // permanent: never retried despite attempts: 3

    // the worker is intact and still does useful work
    expect(host.isReady).toBe(true);
    const { jobId } = await h.producer.enqueue(testJobs.succeed, {});
    await untilState(jobId, 'completed');
  });
});

describe('delivery semantics', () => {
  it('adding a job with an existing jobId does not create a second job (queue-level de-duplication)', async () => {
    await h.startHost();
    const first = await h.producer.enqueue(testJobs.idempotent, {}, { jobId: 'invoice-42' });
    await untilState(first.jobId, 'completed');
    const second = await h.producer.enqueue(testJobs.idempotent, {}, { jobId: 'invoice-42' });

    expect(second.jobId).toBe(first.jobId);
    expect(h.controls.executionsOf('invoice-42')).toHaveLength(1);
  });

  it('may deliver the same job twice, and an idempotent processor makes that harmless', async () => {
    await h.startHost();
    const { jobId } = await h.producer.enqueue(testJobs.idempotent, {});
    await untilState(jobId, 'completed');

    // Re-deliver the same job: what a stalled-job recovery or a manual retry does. This is the documented at-least-once contract.
    await (await h.queue.getJob(jobId))?.retry('completed');
    await waitFor(() => h.controls.executionsOf(jobId).length === 2, { message: 'second delivery' });
    await untilState(jobId, 'completed');

    expect(h.controls.executionsOf(jobId)).toHaveLength(2); // delivered twice...
    expect([...h.controls.effects]).toEqual([jobId]); // ...applied once
  });
});

describe('shutdown', () => {
  it('stops taking work, waits for the active job, and only then acknowledges it', async () => {
    const host = await h.startHost({ concurrency: 1 });
    const { jobId } = await h.producer.enqueue(testJobs.hold, {});
    await h.controls.startedSignal(jobId).promise;

    const stopping = host.stop('test');
    expect(host.state).toBe('draining');
    expect(host.isReady).toBe(false);

    // A job submitted after shutdown began must not be picked up.
    const late = await h.producer.enqueue(testJobs.succeed, {});

    // The active job is NOT acknowledged while it is still running.
    expect(await h.jobState(jobId)).toBe('active');

    h.controls.releaseSignal(jobId).resolve();
    const result = await stopping;

    expect(result).toMatchObject({ forced: false, abandonedJobs: 0 });
    expect(host.state).toBe('stopped');
    expect(await h.jobState(jobId)).toBe('completed'); // finished work is acknowledged
    expect(await h.jobState(late.jobId)).toBe('waiting'); // new work was left for another worker
    expect(h.controls.executionsOf(late.jobId)).toHaveLength(0);
  });

  it('is idempotent: stopping twice (or before starting) is safe', async () => {
    const never = h.createHost();
    expect(await never.stop('test')).toMatchObject({ forced: false });
    expect(never.state).toBe('stopped');

    const host = await h.startHost();
    const [one, two] = await Promise.all([host.stop('first'), host.stop('second')]);
    expect(two).toBe(one);
    expect(host.state).toBe('stopped');
    expect(host.status().redis).not.toBe('ready');
  });

  it('abandons a job that outlives the grace period WITHOUT acknowledging it, and another worker then recovers it', async () => {
    const host = await h.startHost({ shutdownGraceMs: 300, concurrency: 1 });
    const { jobId } = await h.producer.enqueue(testJobs.hold, {});
    await h.controls.startedSignal(jobId).promise;

    const result = await host.stop('test');
    expect(result).toMatchObject({ forced: true, abandonedJobs: 1 });
    expect(host.state).toBe('stopped');
    expect(h.controls.abortedJobs.has(jobId)).toBe(true); // the handler was told to stop

    // Neither completed nor failed: the unfinished work was not silently acknowledged.
    expect(await h.jobState(jobId)).toBe('active');
    expect(h.logsWhere((l) => l.jobId === jobId && l.msg === 'job completed')).toHaveLength(0);
    expect(h.logsWhere((l) => l.jobId === jobId && l.failureClass === 'aborted')[0]).toMatchObject({
      reason: 'shutdown',
      willRetry: false,
    });

    // A new worker finds the expired lock (stalled job) and runs it again.
    h.controls.releaseSignal(jobId).resolve(); // so the re-run can finish
    await h.startHost({ name: 'it-worker-2' });
    await untilState(jobId, 'completed');
    expect(h.controls.executionsOf(jobId).length).toBeGreaterThanOrEqual(2);
  });
});

describe('Redis connection', () => {
  it('is not ready until Redis is reachable, and fails startup with a redacted message', async () => {
    const url = 'redis://:very-secret-password@127.0.0.1:1/15'; // nothing listens on port 1
    const host = h.createHost({ redisUrl: url, startupTimeoutMs: 1_000 });

    const error = await host.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StartupError);
    expect(String((error as Error).message)).not.toContain('very-secret-password');
    expect(String((error as Error).message)).toContain('127.0.0.1:1');
    expect(host.isReady).toBe(false);
    expect(host.state).toBe('stopped');
    expect(h.capture.text()).not.toContain('very-secret-password');
  });

  it('becomes not-ready when Redis disappears, recovers by itself, and then processes jobs again', async () => {
    const real = new URL(testRedisUrl());
    const proxy = new RedisProxy({ host: real.hostname, port: Number(real.port || 6379) });
    const proxyPort = await proxy.start();
    const viaProxy = new URL(real);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxyPort);

    try {
      const host = await h.startHost({ redisUrl: viaProxy.toString() });
      expect(host.isReady).toBe(true);

      const before = await h.producer.enqueue(testJobs.succeed, {});
      await untilState(before.jobId, 'completed');

      await proxy.cut(); // Redis "goes away"
      await waitFor(() => !host.isReady, { message: 'worker to report not-ready' });
      expect(host.state).toBe('running'); // it did not crash or exit
      expect(h.logsWhere((l) => l.msg.startsWith('redis connection lost'))).toHaveLength(1);

      // Jobs submitted while the worker cannot reach Redis wait in Redis (the producer talks to the real one).
      const during = await h.producer.enqueue(testJobs.succeed, {});
      expect(await h.jobState(during.jobId)).toBe('waiting');

      await proxy.restore(); // Redis "comes back"
      await waitFor(() => host.isReady, { message: 'worker to become ready again' });
      await untilState(during.jobId, 'completed');
      expect(h.logsWhere((l) => l.msg.startsWith('redis connection restored'))).toHaveLength(1);

      // The outage produced a bounded number of log lines, not one per reconnect attempt.
      expect(h.logsWhere((l) => l.msg.startsWith('redis connection error')).length).toBeLessThanOrEqual(2);
    } finally {
      await proxy.close();
    }
  });
});
