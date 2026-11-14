import type { Logger } from '@agentos/logger';
import type { WorkerConfig } from './config';
import { createRegistry } from './processors';
import { WorkerHost, type StuckHandlerInfo } from './runtime';

/** Wires configuration, the processor registry and the runtime into a host. The only place those three meet. */
export function createWorkerHost(
  config: WorkerConfig,
  logger: Logger,
  hooks: { onStuckHandler?: (info: StuckHandlerInfo) => void } = {},
): WorkerHost {
  return new WorkerHost({
    name: config.WORKER_NAME,
    redisUrl: config.REDIS_URL,
    prefix: config.QUEUE_PREFIX,
    queues: config.WORKER_QUEUES,
    registry: createRegistry(),
    logger,
    concurrency: config.WORKER_CONCURRENCY,
    jobTimeoutMs: config.WORKER_JOB_TIMEOUT_MS,
    abortGraceMs: config.WORKER_ABORT_GRACE_MS,
    ...(hooks.onStuckHandler === undefined ? {} : { onStuckHandler: hooks.onStuckHandler }),
    shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE_MS,
    lockDurationMs: config.WORKER_LOCK_DURATION_MS,
    startupTimeoutMs: config.WORKER_STARTUP_TIMEOUT_MS,
  });
}
