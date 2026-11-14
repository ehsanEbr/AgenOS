import { defineJob } from '@agentos/contracts';
import { z } from 'zod';
import { PermanentJobError, ProcessorRegistry, defineProcessor } from '../../src/runtime';
import { type Deferred, deferred } from './env';

/*
 * Test-only job types on the `system` queue (the only queue that exists). They exercise the runtime's behavior and are
 * never registered in the real worker process.
 */
const payload = z.object({ note: z.string().optional(), failTimes: z.number().int().optional() });
const job = (type: string) => defineJob({ queue: 'system', type, version: 1, payload });

export const testJobs = {
  succeed: job('test.succeed'),
  /** Fails with an ordinary (retryable) error for the first `failTimes` attempts, then succeeds. */
  flaky: job('test.flaky'),
  failAlways: job('test.fail_always'),
  permanent: job('test.permanent'),
  /** Runs until the test releases it (or the job is aborted). Lets a test observe a job that is genuinely in flight. */
  hold: job('test.hold'),
  /** Never finishes and ignores its abort signal: a misbehaving handler. */
  never: job('test.never'),
  /** Applies its effect once per jobId, however many times it is delivered: the documented idempotency pattern. */
  idempotent: job('test.idempotent'),
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
        controls.startedSignal(ctx.jobId).resolve();
        await new Promise<void>((resolve, reject) => {
          void controls.releaseSignal(ctx.jobId).promise.then(resolve);
          ctx.signal.addEventListener('abort', () => {
            controls.abortedJobs.add(ctx.jobId);
            reject(ctx.signal.reason);
          });
        });
      }),
    )
    .register(
      defineProcessor(testJobs.never, async (_payload, ctx) => {
        record('test.never', ctx);
        controls.startedSignal(ctx.jobId).resolve();
        ctx.signal.addEventListener('abort', () => controls.abortedJobs.add(ctx.jobId));
        await new Promise<never>(() => undefined);
      }),
    )
    .register(
      defineProcessor(testJobs.idempotent, (_payload, ctx) => {
        record('test.idempotent', ctx);
        controls.effects.add(ctx.jobId); // a Set: applying the effect twice is the same as once
      }),
    );
}
