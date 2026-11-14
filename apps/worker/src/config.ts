import {
  ConfigError,
  csvSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseConfig,
  redisUrlSchema,
} from '@agentos/config';
import { QUEUE_NAMES, type QueueName, isQueueName } from '@agentos/contracts';
import { DEFAULT_QUEUE_PREFIX, queuePrefixSchema } from '@agentos/queue';
import { z } from 'zod';

export { ConfigError };

/**
 * Worker configuration. Only what a worker process genuinely needs; every value is validated at startup and an invalid
 * value stops the process (exit code 2) with a message that names the variable but never its value.
 * Retry/backoff is NOT here: it is a property of the queue and the job, defined in code (@agentos/queue) so producers and
 * workers cannot disagree; see workers.md.
 */
export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  /** Same variable and same Redis the API uses. Credentials are never logged. */
  REDIS_URL: redisUrlSchema,
  /** Redis key namespace for queues. Must match the producers'. */
  QUEUE_PREFIX: queuePrefixSchema.default(DEFAULT_QUEUE_PREFIX),
  /** Name shown in logs and in Redis; give each deployed worker a distinct one. */
  WORKER_NAME: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
    .default('worker'),
  /** Comma-separated queues this process consumes. Specialized workers differ by this list (and their processors). */
  WORKER_QUEUES: csvSchema.default([QUEUE_NAMES.system]).pipe(
    z
      .array(z.string())
      .min(1, 'at least one queue is required')
      .refine((names) => new Set(names).size === names.length, 'queue names must be unique')
      .refine(
        (names) => names.every(isQueueName),
        `unknown queue; known queues: ${Object.values(QUEUE_NAMES).join(', ')}`,
      )
      .transform((names) => names as QueueName[]),
  ),
  /** Jobs processed in parallel, per queue. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /** A handler that runs longer than this gets its AbortSignal aborted; the attempt is retried once the handler has ended. */
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  /**
   * How long a handler may keep running after its timeout before the worker concludes it is stuck, shuts down and exits (code 1)
   * so a supervisor restarts it. Nothing else can stop a handler that ignores its AbortSignal.
   */
  WORKER_ABORT_GRACE_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
  /** On SIGTERM/SIGINT: how long to wait for running jobs before abandoning them. Keep it below the orchestrator's kill timeout. */
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
  /** Give up starting (exit code 1) if Redis is not usable within this time. After startup, Redis outages are survived. */
  WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  /**
   * Path of the heartbeat file that `dist/healthcheck.js` reads (Docker HEALTHCHECK). Unset = health reporting disabled.
   * There is deliberately no HTTP health port: see workers.md.
   */
  WORKER_HEALTH_FILE: z.string().min(1).optional(),
  /** How long a job's lock lasts without renewal: a crashed worker's jobs are redelivered after about this long. */
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
});
export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return parseConfig(workerEnvSchema, env);
}
