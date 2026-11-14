import type { JobDefinition } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import type { z } from 'zod';

/*
 * THE PROCESSOR CONTRACT. Every job handler in AgentOS is written against this file.
 *
 * Delivery is AT-LEAST-ONCE, never exactly-once. A handler can run more than once for the same job when:
 *   - the worker process crashed (or was force-stopped) while the job was active: the job is redelivered after its lock expires;
 *   - the job exceeded its timeout: it is retried, but only after the first execution has ENDED (never beside it);
 *   - the handler failed with a retryable error and the job is retried (that is the point of retries);
 *   - a producer enqueued the same operation twice under different job ids.
 *
 * Therefore a handler MUST be idempotent: running it twice for the same logical job must have the same effect as once.
 * How, in practice (no framework is provided on purpose; the right mechanism depends on the domain):
 *   - derive an idempotency key from the business operation (usually an entity id carried in the payload, or `ctx.jobId`);
 *   - make the effect conditional on it: an upsert, a unique constraint, "UPDATE ... WHERE status = 'queued'",
 *     a compare-and-set on a state column, or a record of completed steps;
 *   - external calls that are not naturally idempotent need the provider's idempotency key (pass `ctx.jobId`);
 *   - check `ctx.signal`: when it aborts (timeout or forced shutdown) stop promptly. Aborting does NOT stop a function. A handler
 *     that ignores the signal keeps its slot and its job, is never retried beside itself, and after WORKER_ABORT_GRACE_MS the
 *     worker process restarts to get rid of it. Never block the event loop for long (a synchronous loop cannot be timed out).
 * `ctx.attempt` tells you this is a retry (diagnostics only, never use it to decide whether work was already done).
 *
 * Failing: throw any Error for a RETRYABLE failure (a dependency was down). Throw `PermanentJobError` when retrying can
 * never help (the entity no longer exists, the input is semantically invalid): the job goes straight to `failed`.
 * Error messages are stored in Redis as the failure reason and logged: never put secrets or personal data in them.
 */

export interface JobContext {
  /** BullMQ's id for the job: stable across retries and redeliveries. Use it as an idempotency key. */
  readonly jobId: string;
  readonly queue: string;
  readonly type: string;
  readonly version: number;
  /** Joins this execution to the request/job that created it; already present on every log line of `logger`. */
  readonly correlationId: string;
  /** 1 for the first execution, 2 for the first retry, ... A redelivery after a crash repeats the same attempt number. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly isLastAttempt: boolean;
  /** Logger with worker, queue, job id, job type, correlation id and attempt already attached. Never log the payload. */
  readonly logger: Logger;
  /** Aborts when the job times out or the worker is forced to stop. Pass it to I/O (`fetch`, drivers) where supported. */
  readonly signal: AbortSignal;
}

export type JobHandler<S extends z.ZodType> = (payload: z.output<S>, ctx: JobContext) => Promise<void> | void;

export interface JobProcessor<S extends z.ZodType = z.ZodType> {
  readonly definition: JobDefinition<S>;
  readonly handle: JobHandler<S>;
}

/** Registers a handler for a job definition. The payload type is inferred from the definition's schema. */
export function defineProcessor<S extends z.ZodType>(
  definition: JobDefinition<S>,
  handle: JobHandler<S>,
): JobProcessor<S> {
  return { definition, handle };
}

/**
 * Signals that retrying cannot help. The job is marked failed immediately (no further attempts) and stays inspectable.
 * Use it for conditions that will not change between attempts; use a plain Error for anything transient.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. Lets a handler wait without outliving its timeout. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
