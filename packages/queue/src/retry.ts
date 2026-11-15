import type { JobsOptions } from 'bullmq';
import { z } from 'zod';

/** No job may be retried more than this many times in total, whatever a producer asks for. */
export const MAX_ATTEMPTS = 10;
/** The longest single wait between two attempts the policy may produce (1 hour). */
export const MAX_SINGLE_DELAY_MS = 3_600_000;

/**
 * Retry policy of a queue (and optionally of one job). Retries are EXPONENTIAL with jitter:
 *
 *   nominal wait after failed attempt n = backoffMs * 2^(n-1)
 *   actual wait                         = random between (1 - jitter) * nominal and nominal   (BullMQ's definition)
 *
 * so with the defaults (3 attempts, 1 s, jitter 0.5) a failing job runs at t=0, again after 0.5-1 s, again after 1-2 s,
 * and then stays in the `failed` set. Jitter never lengthens a wait, so the nominal value is the guaranteed ceiling.
 * Exponential growth keeps a struggling dependency from being hammered; jitter keeps many jobs that failed together from
 * retrying together (a retry storm); a finite `attempts` makes infinite loops impossible.
 * Permanent failures (invalid input, unknown job) skip retries entirely: see `PermanentJobError` in the worker runtime.
 */
export const retryPolicySchema = z
  .object({
    /** Total executions including the first. 1 = never retry. */
    attempts: z.number().int().min(1).max(MAX_ATTEMPTS),
    /** Base delay in milliseconds. */
    backoffMs: z.number().int().min(100).max(300_000),
    /** 0 (none) to 1 (full): the fraction of the nominal delay that may be randomly subtracted. */
    jitter: z.number().min(0).max(1),
  })
  .refine((p) => p.backoffMs * 2 ** Math.max(p.attempts - 2, 0) <= MAX_SINGLE_DELAY_MS, {
    message: `The longest wait between attempts would exceed ${MAX_SINGLE_DELAY_MS} ms`,
  });
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 3, backoffMs: 1_000, jitter: 0.5 };

/**
 * How long BullMQ keeps finished jobs. Failed jobs are kept for a week (and at most 5000), so a job that exhausted its
 * attempts stays inspectable (`failedReason`, `attemptsMade`); completed jobs for an hour. Redis memory is bounded either way.
 * The completed retention is also the window in which a re-used custom `jobId` is treated as a duplicate.
 */
export const DEFAULT_RETENTION = {
  completed: { age: 3_600, count: 1_000 },
  failed: { age: 7 * 24 * 3_600, count: 5_000 },
} as const;

/** Translates a validated policy into BullMQ job options (the only place that knows BullMQ's option names). */
export function toJobOptions(policy: RetryPolicy): JobsOptions {
  const validated = retryPolicySchema.parse(policy);
  return {
    attempts: validated.attempts,
    backoff: { type: 'exponential', delay: validated.backoffMs, jitter: validated.jitter },
    removeOnComplete: { ...DEFAULT_RETENTION.completed },
    removeOnFail: { ...DEFAULT_RETENTION.failed },
  };
}
