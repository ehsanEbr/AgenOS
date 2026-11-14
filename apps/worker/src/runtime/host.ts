import { redactUrl } from '@agentos/config';
import type { QueueName } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import { type Redis, createRedisConnection } from '@agentos/queue';
import { UnrecoverableError, Worker } from 'bullmq';
import { type JobLike, JobFailure, type StuckHandlerInfo, createDispatcher } from './dispatch';
import { type HostState, Lifecycle } from './lifecycle';
import type { ProcessorRegistry } from './registry';
import { TimeoutError, settlesWithin, withTimeout } from './util';

export interface WorkerHostOptions {
  /** Shown in logs and in Redis (`queue.getWorkers()`), so operators can tell workers apart. */
  name: string;
  redisUrl: string;
  /** Redis key namespace; must equal the producers' prefix. */
  prefix: string;
  /** Queues to consume. Each needs at least one registered processor. */
  queues: readonly QueueName[];
  registry: ProcessorRegistry;
  logger: Logger;
  /** Jobs processed in parallel PER QUEUE. */
  concurrency: number;
  /**
   * A handler that does not finish in this time has its signal aborted and the attempt will count as failed (retried) as soon
   * as the handler ends. The runtime NEVER retries while the handler may still be running: see `abortGraceMs`.
   */
  jobTimeoutMs: number;
  /**
   * How long a handler may keep running after its timeout fired (its signal is aborted) before the runtime reports it as stuck.
   * Default 10 s. A stuck handler keeps its slot and its job; it is never overlapped by a retry.
   */
  abortGraceMs?: number;
  /**
   * Called when a handler is stuck (see `abortGraceMs`). The only reliable remedy is to stop the PROCESS, so the worker entry
   * point shuts the host down and exits; an embedder that does not do something equivalent keeps a permanently occupied slot.
   */
  onStuckHandler?: (info: StuckHandlerInfo) => void;
  /** How long shutdown waits for active jobs before abandoning them. */
  shutdownGraceMs: number;
  /** How long a job's lock lasts without renewal; a crashed worker's jobs are redelivered after about this long. */
  lockDurationMs: number;
  /** `start()` gives up (and releases everything) if Redis is not usable within this time. */
  startupTimeoutMs: number;
}

export interface HostStatus {
  state: HostState;
  /** True only while running AND the Redis connection is up. A worker that cannot reach Redis is never ready. */
  ready: boolean;
  /** ioredis status: `ready`, `connecting`, `reconnecting`, `close`, `end`; `none` before start. */
  redis: string;
  activeJobs: number;
}

export interface ShutdownResult {
  /** True when the grace period expired and active jobs were abandoned (they are redelivered after their lock expires). */
  forced: boolean;
  /** Jobs that were still running when they were abandoned; 0 for a clean drain. */
  abandonedJobs: number;
  durationMs: number;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * The reusable worker runtime: owns the Redis connection, one BullMQ worker per queue, the life cycle and the shutdown.
 * It knows nothing about any job: processors are handed in through the registry, so specialized workers (agent, repository,
 * MCP, scheduler) are a different registry and queue list, not a different runtime. No NestJS, no database.
 *
 * Shutdown (see workers.md): stop fetching -> wait for active jobs up to the grace period -> if they finished, close cleanly;
 * if not, force-close WITHOUT acknowledging them, so they are redelivered after their lock expires. At-least-once is preserved.
 */
export class WorkerHost {
  private readonly lifecycle = new Lifecycle();
  private readonly log: Logger;
  private readonly shutdownController = new AbortController();
  private connection?: Redis;
  private workers: Worker[] = [];
  private activeJobs = 0;
  private redisLost = false;
  private errorLogged = false;
  private stopping?: Promise<ShutdownResult>;

  constructor(private readonly options: WorkerHostOptions) {
    this.log = options.logger;
    const consumable = new Set(options.registry.queues());
    const missing = options.queues.filter((queue) => !consumable.has(queue));
    if (options.queues.length === 0) throw new Error('A worker needs at least one queue');
    if (missing.length > 0) {
      throw new Error(
        `No processor is registered for queue(s): ${missing.join(', ')}. A queue without processors would fail every job.`,
      );
    }
  }

  get state(): HostState {
    return this.lifecycle.state;
  }

  get isReady(): boolean {
    return this.lifecycle.state === 'running' && this.connection?.status === 'ready';
  }

  status(): HostStatus {
    return {
      state: this.lifecycle.state,
      ready: this.isReady,
      redis: this.connection?.status ?? 'none',
      activeJobs: this.activeJobs,
    };
  }

  /** Connects and starts consuming. Resolves when ready; rejects with StartupError (after releasing everything) if it cannot. */
  async start(): Promise<void> {
    this.lifecycle.transition('starting');
    const { options, log } = this;

    const connection = createRedisConnection(options.redisUrl, {
      role: 'worker',
      name: `agentos:${options.name}:${process.pid}`,
      onError: (error) => this.onConnectionError(error),
    });
    this.connection = connection;
    connection.on('ready', () => {
      this.errorLogged = false;
      if (this.redisLost) log.info('redis connection restored; worker is ready again');
      this.redisLost = false;
    });
    connection.on('close', () => {
      if (this.lifecycle.state === 'running' && !this.redisLost) {
        this.redisLost = true;
        log.warn(
          'redis connection lost; the worker is not ready until it reconnects (jobs already running continue)',
        );
      }
    });

    const dispatch = createDispatcher({
      registry: options.registry,
      logger: log,
      jobTimeoutMs: options.jobTimeoutMs,
      shutdownSignal: this.shutdownController.signal,
      ...(options.abortGraceMs === undefined ? {} : { abortGraceMs: options.abortGraceMs }),
      ...(options.onStuckHandler === undefined ? {} : { onStuckHandler: options.onStuckHandler }),
    });
    this.workers = options.queues.map((queue) => this.createWorker(queue, dispatch, connection));

    try {
      await withTimeout(
        Promise.all(this.workers.map((worker) => worker.waitUntilReady())),
        options.startupTimeoutMs,
        'Worker startup',
      );
    } catch (error) {
      if (this.lifecycle.state === 'starting') {
        this.lifecycle.transition('failed');
        await this.forceRelease();
        this.lifecycle.transition('stopped');
      }
      throw new StartupError(
        error instanceof TimeoutError
          ? `Redis (${redactUrl(options.redisUrl)}) was not usable within ${options.startupTimeoutMs} ms`
          : 'The worker could not start',
      );
    }

    if (this.lifecycle.state !== 'starting') return; // stop() was requested while starting and has taken over
    this.lifecycle.transition('running');
    log.info(
      {
        queues: options.queues,
        concurrency: options.concurrency,
        jobTimeoutMs: options.jobTimeoutMs,
        shutdownGraceMs: options.shutdownGraceMs,
        redis: redactUrl(options.redisUrl),
        pid: process.pid,
      },
      'worker ready',
    );
  }

  /** Graceful shutdown. Idempotent: every call returns the same result. */
  stop(reason: string): Promise<ShutdownResult> {
    this.stopping ??= this.shutdown(reason);
    return this.stopping;
  }

  private createWorker(
    queue: QueueName,
    dispatch: ReturnType<typeof createDispatcher>,
    connection: Redis,
  ): Worker {
    const { options, log } = this;
    const worker = new Worker(
      queue,
      async (job) => {
        this.activeJobs += 1;
        try {
          await dispatch(job as JobLike);
        } catch (error) {
          // BullMQ retries every rejection except an UnrecoverableError.
          if (error instanceof JobFailure && error.failureClass === 'permanent')
            throw new UnrecoverableError(error.message);
          throw error;
        } finally {
          this.activeJobs -= 1;
        }
      },
      {
        connection,
        prefix: options.prefix,
        concurrency: options.concurrency,
        lockDuration: options.lockDurationMs,
        stalledInterval: options.lockDurationMs,
        maxStalledCount: 1, // a job that stalls twice is failed, not redelivered forever
        name: options.name,
      },
    );
    // BullMQ emits 'error' for problems that are not tied to a job (connection loss). Without a listener Node would throw.
    worker.on('error', (error) => {
      if (!this.redisLost) log.error({ queue, errorName: error.name }, 'worker error');
    });
    worker.on('stalled', (jobId) =>
      log.warn({ queue, jobId }, 'job stalled (its lock expired while active); it will be redelivered'),
    );
    worker.on('failed', (job, error) => {
      if (error.message.includes('job stalled more than allowable limit')) {
        log.error({ queue, jobId: job?.id }, 'job failed permanently: it stalled more often than allowed');
      }
    });
    return worker;
  }

  private onConnectionError(error: Error): void {
    if (this.errorLogged) return; // one line per outage, not one per reconnect attempt
    this.errorLogged = true;
    const code = (error as NodeJS.ErrnoException).code ?? error.name;
    this.log.warn({ code }, 'redis connection error; retrying in the background');
  }

  private async shutdown(reason: string): Promise<ShutdownResult> {
    const startedAt = performance.now();
    const result = (forced: boolean, abandonedJobs: number): ShutdownResult => ({
      forced,
      abandonedJobs,
      durationMs: Math.round(performance.now() - startedAt),
    });
    const { options, log } = this;

    switch (this.lifecycle.state) {
      case 'created':
        this.lifecycle.transition('stopped');
        return result(false, 0);
      case 'stopped':
        return result(false, 0);
      case 'failed':
        return result(false, 0); // start() is already releasing resources
      case 'starting':
      case 'running':
        this.lifecycle.transition('draining');
        break;
      case 'draining':
        break;
    }

    log.info(
      { reason, activeJobs: this.activeJobs, graceMs: options.shutdownGraceMs },
      'shutdown started; no new jobs will be taken',
    );

    // `pause()` stops fetching immediately and resolves when the jobs already running have finished.
    // (`close()` cannot be upgraded to a forced close once called, so it is only called after this decision.)
    const drained = await settlesWithin(
      Promise.all(this.workers.map((worker) => worker.pause())),
      options.shutdownGraceMs,
    );

    if (drained) {
      await Promise.allSettled(this.workers.map((worker) => worker.close()));
      await this.quitConnection();
      this.lifecycle.transition('stopped');
      const done = result(false, 0);
      log.info(done, 'shutdown complete: all active jobs finished');
      return done;
    }

    const abandoned = this.activeJobs;
    log.warn(
      { abandonedJobs: abandoned, graceMs: options.shutdownGraceMs },
      'shutdown grace period expired; abandoning active jobs WITHOUT acknowledging them (they are redelivered after their lock expires)',
    );
    await this.forceRelease();
    this.lifecycle.transition('stopped');
    const done = result(true, abandoned);
    log.warn(done, 'shutdown complete (forced)');
    return done;
  }

  /**
   * Abandon everything without acknowledging anything. Order matters: BullMQ is told to force-close and the Redis socket
   * is cut BEFORE handlers are told to stop, so a handler that fails because it was aborted can no longer mark its job
   * failed or completed. The job stays "active" with an expiring lock and is redelivered (a stalled job).
   */
  private async forceRelease(): Promise<void> {
    const closing = Promise.allSettled(this.workers.map((worker) => worker.close(true)));
    this.connection?.disconnect();
    this.shutdownController.abort(new Error('worker is shutting down'));
    await closing;
  }

  private async quitConnection(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      // QUIT resolves when Redis acknowledges it; the socket is only closed once ioredis reports `end`.
      const ended = new Promise<void>((resolve) => {
        if (connection.status === 'end') resolve();
        else connection.once('end', () => resolve());
      });
      await withTimeout(
        connection.quit().then(() => ended),
        2_000,
        'Redis QUIT',
      );
    } catch {
      connection.disconnect();
    }
  }
}
