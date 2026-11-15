import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';
import { waitFor } from '../src/wait';

/*
 * The Phase 1.5 timeout guarantee, end to end under a real supervisor.
 *
 * The worker image runs the TEST-ONLY entry (apps/worker/test/support/stuck-main.ts): the real `runWorker`, plus one processor
 * that never ends and ignores its AbortSignal. The shipped worker has no such processor; this exists to observe what the system
 * does when a handler like that appears:
 *
 *   timeout -> abort ignored -> abort grace expires -> the worker shuts down and exits 1 -> Docker restarts it
 *   -> the held job is redelivered after its lock expires (stalled once) -> the same thing happens -> stalled twice
 *   -> BullMQ FAILS the job (maxStalledCount: 1) -> the worker finally stays up.
 *
 * That chain is why a poison job costs a bounded number of restarts and cannot restart workers forever.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await Stack.create({
    workerCommand: ['node', '--import', 'tsx', 'test/support/stuck-main.ts'], // runs from apps/worker (see Stack)
    env: {
      WORKER_JOB_TIMEOUT_MS: '1000',
      WORKER_ABORT_GRACE_MS: '200',
      WORKER_SHUTDOWN_GRACE_MS: '1000',
      WORKER_LOCK_DURATION_MS: '2000',
    },
  });
  await stack.up(['worker']);
});
afterAll(async () => {
  await stack.destroy();
});

describe('a handler that ignores its AbortSignal, under the container supervisor', () => {
  it('restarts the worker (exit 1) until BullMQ fails the poison job, then the worker stays healthy', async () => {
    const stuck = { type: 'test.stuck', version: 1, payload: {} };
    // The producer API takes a contract-defined job; this test-only job type is not in contracts, so it is added raw with the same
    // envelope the producer would write (and the same retry policy).
    const job = await stack
      .queue()
      .add(
        'test.stuck',
        { ...stuck, correlationId: 'systest-stuck', createdAt: new Date().toISOString() },
        { attempts: 3, backoff: { type: 'exponential', delay: 100 } },
      );
    const jobId = String(job.id);

    await waitFor(async () => (await stack.jobState(jobId)) === 'failed', {
      message: 'BullMQ to fail the job that keeps stalling',
      timeoutMs: 120_000,
    });
    const failed = await stack.queue().getJob(jobId);
    expect(failed?.failedReason).toContain('stalled'); // failed by the stalled-job limit, not retried forever

    const state = await waitFor(
      async () => {
        const s = await stack.state('worker');
        return s.status === 'running' && s.health === 'healthy' ? s : undefined;
      },
      { message: 'the worker to be running and healthy again', timeoutMs: 90_000 },
    );
    expect(state.restartCount).toBeGreaterThanOrEqual(1); // the supervisor DID restart it...
    expect(state.restartCount).toBeLessThan(5); // ...a bounded number of times, well inside the policy's limit

    const logs = await stack.logs('worker');
    expect(logs).toContain('a handler is stuck after its timeout'); // the fatal log line that explains every one of those restarts
    expect(
      logs.split('\n').filter((l) => l.includes('"msg":"stuck handler started"')).length,
    ).toBeGreaterThanOrEqual(2); // it did run again after a restart
  });
});
