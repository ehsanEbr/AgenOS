import { z } from 'zod';

/*
 * Background-job contracts: what a producer (API, scheduler) and a worker must agree on. Framework-free: no BullMQ,
 * no Redis. BullMQ-specific behavior lives in @agentos/queue and the worker runtime. See docs/architecture/workers.md.
 */

/**
 * Queues AgentOS knows about. Only `system` exists today; the specification's queues (agent-executions,
 * repository-indexing, mcp-executions, ...) are added in the phase that implements their domain, not before.
 */
export const QUEUE_NAMES = {
  /** Diagnostics and infrastructure checks. Not a product feature. */
  system: 'system',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_NAME_LIST = Object.values(QUEUE_NAMES) as QueueName[];

export const isQueueName = (value: unknown): value is QueueName =>
  typeof value === 'string' && (QUEUE_NAME_LIST as string[]).includes(value);

/** `<area>.<action>`, lowercase: `system.ping`, `agent.execute`. Selects the processor inside a queue. */
export const JOB_TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
export const jobTypeSchema = z.string().max(100).regex(JOB_TYPE_PATTERN);

/** Same character set the API accepts for `x-correlation-id`, so one id can travel from an HTTP request into a job. */
export const correlationIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

/**
 * The envelope every job carries as its BullMQ `data`. Deliberately minimal:
 *
 *  - `type`           which processor handles it
 *  - `version`        version of THAT TYPE's payload schema, so a worker can refuse payloads it does not understand
 *                     (a permanent failure) instead of guessing; producers bump it for breaking payload changes
 *  - `correlationId`  joins worker logs to the API request / job that caused them
 *  - `createdAt`      when the producer created it (diagnostics, age/latency metrics)
 *  - `payload`        type-specific data, validated by the processor's schema at the worker boundary
 *
 * NOT in the envelope, because BullMQ already provides them reliably: the job id (`job.id`), the queue name
 * (`job.queueName`), the attempt count (`job.attemptsMade`) and timestamps of processing.
 * Unknown extra fields are ignored, so adding an optional field is backward compatible; a breaking envelope change
 * requires a new queue.
 *
 * Never put credentials or secrets in a payload: payloads are stored in Redis and visible to anyone who can inspect the
 * queue. Reference entities by id (spec 11.3).
 */
export const jobEnvelopeSchema = z.object({
  type: jobTypeSchema,
  version: z.number().int().min(1).max(10_000),
  correlationId: correlationIdSchema,
  createdAt: z.iso.datetime(),
  payload: z.unknown(),
});
export type JobEnvelope<TPayload = unknown> = Omit<z.infer<typeof jobEnvelopeSchema>, 'payload'> & {
  payload: TPayload;
};

/**
 * A typed job definition: which queue, which type, which payload version and the schema of that payload.
 * Producers use it to build a valid job; the worker's processor is registered against the same object, so both sides
 * share one definition.
 */
export interface JobDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly queue: QueueName;
  readonly type: string;
  readonly version: number;
  readonly payload: TSchema;
}

export function defineJob<TSchema extends z.ZodType>(
  definition: JobDefinition<TSchema>,
): JobDefinition<TSchema> {
  if (!JOB_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`Invalid job type "${definition.type}": expected <area>.<action>, lowercase`);
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(`Invalid version for job "${definition.type}": expected a positive integer`);
  }
  return definition;
}

/**
 * Diagnostic job proving the pipeline end to end (producer -> Redis -> worker -> processor). It does nothing useful on
 * purpose and touches no domain data. `delayMs` simulates work, which operators and tests use to observe shutdown and
 * recovery behavior with a job that is genuinely in flight.
 */
export const MAX_PING_DELAY_MS = 60_000;
export const systemPingJob = defineJob({
  queue: QUEUE_NAMES.system,
  type: 'system.ping',
  version: 1,
  payload: z.object({
    message: z.string().max(200).optional(),
    delayMs: z.number().int().min(0).max(MAX_PING_DELAY_MS).default(0),
  }),
});
