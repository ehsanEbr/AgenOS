import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deferred, staysTrue, waitFor } from './support/env';
import { Harness } from './support/harness';
import { testJobs } from './support/test-processors';

/*
 * Timeout and handler-execution safety, against a REAL Redis.
 *
 * The question: when a handler outlives its timeout and ignores its AbortSignal, can a second execution of the same job start
 * while the first is still running? JavaScript cannot kill a running async function, so these tests never assume that aborting
 * a signal stops anything. Every test steers the handlers through explicit synchronization points (started / aborted /
 * released / settled) instead of sleeping. `peakConcurrency` is the oracle: 1 means executions never overlapped.
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
const RETRY_2 = { attempts: 2, backoffMs: 100, jitter: 0 } as const;
/** Long enough that a regression (a retry that starts anyway) would have shown, short enough to keep the suite fast. */
const NO_RETRY_WINDOW_MS = 700;

describe('a handler that respects its AbortSignal', () => {
  it('stops when the timeout fires; the retry starts only after it stopped, and executions never overlap', async () => {
    await h.startHost({ jobTimeoutMs: 300 });
    const { jobId } = await h.producer.enqueue(testJobs.hold, {}, { retry: RETRY_2 });

    await untilState(jobId, 'failed'); // both attempts time out
    expect(h.controls.executionsOf(jobId).map((e) => e.attempt)).toEqual([1, 2]);
    expect(h.controls.peakConcurrency(jobId)).toBe(1);
    expect(
      h.logsWhere((l) => l.jobId === jobId && l.failureClass === 'timeout').map((l) => l.willRetry),
    ).toEqual([true, false]);
  });
});

describe('a handler that IGNORES its AbortSignal', () => {
  it('cannot be overlapped by a retry: the job stays owned by the running handler until it settles', async () => {
    await h.startHost({ jobTimeoutMs: 300 });
    const id = 'ignore-overlap';
    await h.producer.enqueue(testJobs.ignoreAbort, {}, { jobId: id, retry: RETRY_2 });

    await h.controls.attemptStarted(id, 1).promise;
    await h.controls.attemptAborted(id, 1).promise; // the timeout has fired and the handler was told to stop; it ignores that

    // With the timeout fired but the handler still running, the retry must NOT begin (it would run the job twice at once).
    await staysTrue(
      async () => h.controls.executionsOf(id).length === 1 && (await h.jobState(id)) === 'active',
      NO_RETRY_WINDOW_MS,
      'no second execution, and the job is not released while its handler is running',
    );

    // Once the handler really ends, the attempt is failed and the retry may run.
    h.controls.attemptRelease(id, 2).resolve();
    h.controls.attemptRelease(id, 1).resolve();
    await untilState(id, 'completed'); // attempt 2 succeeds quickly (released in advance)

    expect(h.controls.executionsOf(id).map((e) => e.attempt)).toEqual([1, 2]);
    expect(h.controls.peakConcurrency(id)).toBe(1);
  });

  it('decides the attempt by the timer: a LATE SUCCESS does not turn the attempt into a success', async () => {
    await h.startHost({ jobTimeoutMs: 300 });
    const id = 'late-success';
    await h.producer.enqueue(
      testJobs.ignoreAbort,
      { outcomes: ['resolve'] },
      { jobId: id, retry: { ...RETRY_2, attempts: 1 } },
    );

    await h.controls.attemptAborted(id, 1).promise;
    h.controls.attemptRelease(id, 1).resolve(); // the handler now finishes successfully, after its timeout
    await untilState(id, 'failed');

    const [failure] = h.logsWhere((l) => l.jobId === id && l.failureClass === 'timeout');
    expect(failure).toMatchObject({ reason: 'timeout', willRetry: false, lateOutcome: 'resolved' });
    expect(h.logsWhere((l) => l.jobId === id && l.msg === 'job completed')).toHaveLength(0);
    const [info] = await h.producer.failedJobs('system');
    expect(info).toMatchObject({
      jobId: id,
      attemptsMade: 1,
      failedReason: expect.stringContaining('timeout'),
    });
  });

  it.each([
    ['an ordinary error', 'reject'],
    ['a PermanentJobError', 'permanent'],
  ] as const)(
    'keeps the classification "timeout" (retryable) when the handler then fails with %s',
    async (_name, outcome) => {
      await h.startHost({ jobTimeoutMs: 300 });
      const id = `late-${outcome}`;
      await h.producer.enqueue(
        testJobs.ignoreAbort,
        { outcomes: [outcome, 'resolve'] },
        { jobId: id, retry: RETRY_2 },
      );

      await h.controls.attemptAborted(id, 1).promise;
      h.controls.attemptRelease(id, 2).resolve();
      h.controls.attemptRelease(id, 1).resolve(); // attempt 1 now rejects, long after its timeout
      await untilState(id, 'completed'); // so the late rejection did not make the job permanent: attempt 2 ran

      const [first] = h.logsWhere(
        (l) => l.jobId === id && l.attempt === 1 && l.msg.startsWith('job attempt failed'),
      );
      expect(first).toMatchObject({
        failureClass: 'timeout',
        reason: 'timeout',
        willRetry: true,
        lateOutcome: 'rejected',
      });
      expect(h.controls.peakConcurrency(id)).toBe(1);
    },
  );
});

describe('shutdown while a timed-out handler is still running', () => {
  it('abandons the job WITHOUT acknowledging it, and the handler finishing later cannot change the job state', async () => {
    const host = await h.startHost({ jobTimeoutMs: 300, shutdownGraceMs: 300, abortGraceMs: 60_000 });
    const id = 'ignore-shutdown';
    await h.producer.enqueue(testJobs.ignoreAbort, {}, { jobId: id, retry: RETRY_2 });
    await h.controls.attemptAborted(id, 1).promise; // timed out, handler still running

    const result = await host.stop('test');
    expect(result).toMatchObject({ forced: true, abandonedJobs: 1 });
    expect(await h.jobState(id)).toBe('active'); // not failed, not completed, not retried

    h.controls.attemptRelease(id, 1).resolve(); // the abandoned handler finally returns successfully
    await h.controls.attemptSettled(id, 1).promise;
    await staysTrue(
      async () => (await h.jobState(id)) === 'active',
      300,
      'late completion must not acknowledge the job',
    );
    expect(h.logsWhere((l) => l.jobId === id && l.msg === 'job completed')).toHaveLength(0);
  });
});

describe('a handler that never stops (backstop)', () => {
  it('holds the job without retrying it, tells the embedder, and is recoverable by a forced shutdown', async () => {
    const stuck = deferred<{ jobId: string }>();
    const host = await h.startHost({
      jobTimeoutMs: 300,
      abortGraceMs: 300,
      shutdownGraceMs: 300,
      onStuckHandler: (info) => stuck.resolve(info),
    });
    const id = 'ignore-forever';
    await h.producer.enqueue(testJobs.ignoreAbort, {}, { jobId: id, retry: RETRY_2 });

    expect(await stuck.promise).toMatchObject({
      jobId: id,
      queue: 'system',
      type: 'test.ignore_abort',
      attempt: 1,
    });
    expect(h.logsWhere((l) => l.jobId === id && l.msg.includes('ignored its abort signal'))).toHaveLength(1);

    // Still held: not retried, still running, still ours.
    await staysTrue(
      async () => h.controls.executionsOf(id).length === 1 && (await h.jobState(id)) === 'active',
      NO_RETRY_WINDOW_MS,
      'a stuck handler is never overlapped by a retry',
    );
    expect(host.state).toBe('running');
    expect(host.status().activeJobs).toBe(1);

    // The embedder's remedy: stop the worker. The job is left unacknowledged for redelivery.
    expect(await host.stop('stuck-handler')).toMatchObject({ forced: true, abandonedJobs: 1 });
    expect(await h.jobState(id)).toBe('active');
    h.controls.attemptRelease(id, 1).resolve(); // free the test's dangling promise
  });
});

describe('lock renewal while a handler is held', () => {
  it('keeps ownership of a timed-out job for much longer than the lock duration, so a second worker cannot take it', async () => {
    // lockDuration is 1 s in the harness and every worker checks for stalled jobs every second: without renewal the second
    // worker would take the job within ~2 s and run it beside the first handler.
    await h.startHost({ name: 'worker-a', jobTimeoutMs: 300, abortGraceMs: 60_000 });
    await h.startHost({ name: 'worker-b', jobTimeoutMs: 300, abortGraceMs: 60_000 });
    const id = 'held-long';
    await h.producer.enqueue(testJobs.ignoreAbort, {}, { jobId: id, retry: RETRY_2 });
    await h.controls.attemptAborted(id, 1).promise;

    await staysTrue(
      async () => h.controls.executionsOf(id).length === 1 && (await h.jobState(id)) === 'active',
      3_200, // more than three lock durations and three stalled-job checks
      'a held job is not redelivered to the other worker',
    );
    expect(h.controls.peakConcurrency(id)).toBe(1);
    expect(h.logsWhere((l) => l.msg.startsWith('job stalled'))).toHaveLength(0);

    h.controls.attemptRelease(id, 1).resolve();
    h.controls.attemptRelease(id, 2).resolve();
    await untilState(id, 'completed');
  });
});
