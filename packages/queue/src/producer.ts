import { randomUUID } from 'node:crypto';
import {
  type JobDefinition,
  type JobEnvelope,
  type QueueName,
  correlationIdSchema,
} from '@agentos/contracts';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { DEFAULT_QUEUE_PREFIX, getQueueDefinition } from './definitions';
import { type RetryPolicy, retryPolicySchema, toJobOptions } from './retry';

export interface EnqueueOptions {
  /**
   * Joins the job to the request/job that caused it. Pass the API's current correlation id; when omitted (a scheduler, a
   * script) a new one is generated, so every job can be traced.
   */
  correlationId?: string;
  /**
   * Makes the job idempotent at the QUEUE level: while a job with this id still exists (waiting, active, delayed, or kept
   * after completion/failure) adding it again is ignored and the existing job is returned. Use a deterministic id derived
   * from the business operation (e.g. `execution-<uuid>`). Not a substitute for idempotent processors: see workers.md.
   */
  jobId?: string;
  /** Delay before the job becomes available, in milliseconds. */
  delayMs?: number;
  /** Overrides parts of the queue's default retry policy for this job. */
  retry?: Partial<RetryPolicy>;
}

export interface EnqueueResult {
  jobId: string;
  correlationId: string;
}

export interface FailedJobInfo {
  jobId: string;
  type: string;
  attemptsMade: number;
  failedReason: string;
  /** Epoch milliseconds when the last attempt failed. */
  failedAt?: number;
  correlationId?: string;
}

// BullMQ rejects ids containing ":" and numeric ids; we additionally keep ids log-safe.
const JOB_ID_PATTERN = /^(?!\d+$)[A-Za-z0-9._-]{1,128}$/;

export interface QueueProducerOptions {
  /** Connection created with `createRedisConnection(url, { role: 'producer', ... })`. The caller owns and closes it. */
  connection: Redis;
  prefix?: string;
  onError?: (error: Error) => void;
}

/**
 * The producing side of a queue: validates the payload with the job's contract schema, wraps it in the envelope, applies
 * the queue's retry policy and adds it to Redis. This class (and the worker runtime) are the only code that talks to BullMQ.
 *
 * It does not own the Redis connection, so a process that already has one (the API's RedisService) can share it.
 */
export class QueueProducer {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly prefix: string;

  constructor(private readonly options: QueueProducerOptions) {
    this.prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  }

  async enqueue<S extends z.ZodType>(
    job: JobDefinition<S>,
    payload: z.input<S>,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    if (options.jobId !== undefined && !JOB_ID_PATTERN.test(options.jobId)) {
      throw new Error('Invalid jobId: use 1-128 letters, digits, "." "_" "-", and not only digits');
    }
    const correlationId = correlationIdSchema.parse(options.correlationId ?? randomUUID());
    const envelope: JobEnvelope<z.output<S>> = {
      type: job.type,
      version: job.version,
      correlationId,
      createdAt: new Date().toISOString(),
      payload: job.payload.parse(payload), // a producer can never send a payload its own contract rejects
    };

    const retry = retryPolicySchema.parse({ ...getQueueDefinition(job.queue).retry, ...options.retry });
    const added = await this.queue(job.queue).add(job.type, envelope, {
      ...toJobOptions(retry),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
    });
    return { jobId: String(added.id), correlationId };
  }

  /** Jobs that exhausted their attempts (or failed permanently), newest first. They stay inspectable until retention expires. */
  async failedJobs(queue: QueueName, limit = 20): Promise<FailedJobInfo[]> {
    const jobs = await this.queue(queue).getFailed(0, Math.max(limit - 1, 0));
    return jobs.map((job) => ({
      jobId: String(job.id),
      type: job.name,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      failedAt: job.finishedOn,
      correlationId: (job.data as Partial<JobEnvelope> | undefined)?.correlationId,
    }));
  }

  /** Closes the queue handles. The Redis connection is left open: its owner closes it. */
  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.options.connection, prefix: this.prefix });
      queue.on('error', (error) => this.options.onError?.(error)); // an unhandled 'error' event would crash the process
      this.queues.set(name, queue);
    }
    return queue;
  }
}
