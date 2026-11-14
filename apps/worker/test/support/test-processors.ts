import { defineJob } from '@agentos/contracts';
import { z } from 'zod';
import { PermanentJobError, ProcessorRegistry, defineProcessor } from '../../src/runtime';
import { type Deferred, deferred } from './env';

/*
 * Test-only job types on the `system` queue (the only queue that exists). They exercise the runtime's behavior and are
 * never registered in the real worker process.
 */
const outcome = z.enum(['resolve', 'reject', 'permanent']);
const payload = z.object({
  note: z.string().optional(),
  failTimes: z.number().int().optional(),
  /** `ignoreAbort` only: how attempt N ends once the test releases it (index N-1; default: resolve). */
  outcomes: z.array(outcome).optional(),
});
const job = (type: string) => defineJob({ queue: 'system', type, version: 1, payload });

export const testJobs = {
  succeed: job('test.succeed'),
  /** Fails with an ordinary (retryable) error for the first `failTimes` attempts, then succeeds. */
  flaky: job('test.flaky'),
  failAlways: job('test.fail_always'),
  permanent: job('test.permanent'),
  /** Runs until the test releases it (or the job is aborted). Lets a test observe a job that is genuinely in flight. */
  hold: job('test.hold'),
  /** Applies its effect once per jobId, however many times it is delivered: the documented idempotency pattern. */
  idempotent: job('test.idempotent'),
  /**
   * Ignores its AbortSignal completely and keeps running until the test releases THAT attempt, then ends as `outcomes` says.
   * Models the dangerous handler: one that does not stop when its timeout fires.
   */
  ignoreAbort: job('test.ignore_abort'),
};

export interface Execution {
  type: string;
  jobId: string;
  attempt: number;
  correlationId: string;
}

/** What the test processors did, and the switches the test uses to steer them. */
export class Controls {
  readonly executions: Execution[] = [];
  /** Effects of the idempotent processor: one entry per distinct jobId. */
  readonly effects = new Set<string>();
  private readonly started = new Map<string, Deferred>();
  private readonly released = new Map<string, Deferred>();
  readonly abortedJobs = new Set<string>();

  startedSignal(jobId: string): Deferred {
    return this.getOrCreate(this.started, jobId);
  }

  releaseSignal(jobId: string): Deferred {
    return this.getOrCreate(this.released, jobId);
  }

  executionsOf(jobId: string): Execution[] {
    return this.executions.filter((e) => e.jobId === jobId);
  }

  // ---- per-attempt synchronization (a job can run several attempts; each one is observed and steered separately) ----
  private readonly attemptSignals = new Map<string, Deferred>();
  private readonly running = new Map<string, number>();
  private readonly peak = new Map<string, number>();

  /** Resolves when attempt `n` of the job has started running its handler. */
  attemptStarted = (jobId: string, n: number): Deferred =>
    this.getOrCreate(this.attemptSignals, `${jobId}#${n}#started`);
  /** Resolves when the handler of attempt `n` observed its AbortSignal firing. */
  attemptAborted = (jobId: string, n: number): Deferred =>
    this.getOrCreate(this.attemptSignals, `${jobId}#${n}#aborted`);
  /** The test resolves this to let attempt `n` finish (a handler that ignores abort waits for it). */
  attemptRelease = (jobId: string, n: number): Deferred =>
    this.getOrCreate(this.attemptSignals, `${jobId}#${n}#release`);
  /** Resolves when the handler function of attempt `n` has actually returned or thrown. */
  attemptSettled = (jobId: string, n: number): Deferred =>
    this.getOrCreate(this.attemptSignals, `${jobId}#${n}#settled`);

  /** Marks a handler as running; returns the function to call when it ends. Tracks the highest concurrency seen per job. */
  trackRunning(jobId: string, n: number): () => void {
    const now = (this.running.get(jobId) ?? 0) + 1;
    this.running.set(jobId, now);
    this.peak.set(jobId, Math.max(this.peak.get(jobId) ?? 0, now));
    this.attemptStarted(jobId, n).resolve();
    return () => {
      this.running.set(jobId, (this.running.get(jobId) ?? 1) - 1);
      this.attemptSettled(jobId, n).resolve();
    };
  }

  /** The most handlers of this job that were ever running AT THE SAME TIME. 1 means executions never overlapped. */
  peakConcurrency(jobId: string): number {
    return this.peak.get(jobId) ?? 0;
  }

  private getOrCreate(map: Map<string, Deferred>, key: string): Deferred {
    let value = map.get(key);
    if (!value) {
      value = deferred();
      map.set(key, value);
    }
    return value;
  }
}

export function createTestRegistry(controls: Controls): ProcessorRegistry {
  const record = (type: string, ctx: { jobId: string; attempt: number; correlationId: string }) =>
    controls.executions.push({
      type,
      jobId: ctx.jobId,
      attempt: ctx.attempt,
      correlationId: ctx.correlationId,
    });

  return new ProcessorRegistry()
    .register(
      defineProcessor(testJobs.succeed, (_payload, ctx) => {
        record('test.succeed', ctx);
      }),
    )
    .register(
      defineProcessor(testJobs.flaky, (data, ctx) => {
        record('test.flaky', ctx);
        if (ctx.attempt <= (data.failTimes ?? 1))
          throw new Error(`transient failure on attempt ${ctx.attempt}`);
      }),
    )
    .register(
      defineProcessor(testJobs.failAlways, (_payload, ctx) => {
        record('test.fail_always', ctx);
        throw new Error('this job always fails');
      }),
    )
    .register(
      defineProcessor(testJobs.permanent, (_payload, ctx) => {
        record('test.permanent', ctx);
        throw new PermanentJobError('the entity no longer exists');
      }),
    )
    .register(
      defineProcessor(testJobs.hold, async (_payload, ctx) => {
        record('test.hold', ctx);
        const done = controls.trackRunning(ctx.jobId, ctx.attempt);
        controls.startedSignal(ctx.jobId).resolve();
        try {
          await new Promise<void>((resolve, reject) => {
            void controls.releaseSignal(ctx.jobId).promise.then(resolve);
            ctx.signal.addEventListener('abort', () => {
              controls.abortedJobs.add(ctx.jobId);
              controls.attemptAborted(ctx.jobId, ctx.attempt).resolve();
              reject(ctx.signal.reason); // the COOPERATIVE handler: it stops when told to
            });
          });
        } finally {
          done();
        }
      }),
    )
    .register(
      defineProcessor(testJobs.ignoreAbort, async (data, ctx) => {
        record('test.ignore_abort', ctx);
        const done = controls.trackRunning(ctx.jobId, ctx.attempt);
        // Observe the signal (so tests know it fired) but deliberately do NOT react to it.
        ctx.signal.addEventListener('abort', () => controls.attemptAborted(ctx.jobId, ctx.attempt).resolve());
        try {
          await controls.attemptRelease(ctx.jobId, ctx.attempt).promise;
          const how = data.outcomes?.[ctx.attempt - 1] ?? 'resolve';
          if (how === 'reject') throw new Error('failed after the timeout had fired');
          if (how === 'permanent') throw new PermanentJobError('permanent error after the timeout had fired');
        } finally {
          done();
        }
      }),
    )
    .register(
      defineProcessor(testJobs.idempotent, (_payload, ctx) => {
        record('test.idempotent', ctx);
        controls.effects.add(ctx.jobId); // a Set: applying the effect twice is the same as once
      }),
    );
}
