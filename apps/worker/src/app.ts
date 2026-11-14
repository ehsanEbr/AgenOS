import type { Logger } from '@agentos/logger';
import type { WorkerConfig } from './config';
import { type ProcessorRegistry, type StuckHandlerInfo, WorkerHost } from './runtime';

/** Wires configuration, a processor registry and the runtime into a host. The registry is passed in (production: `createRegistry()` in main.ts). */
export function createWorkerHost(
  config: WorkerConfig,
  logger: Logger,
  registry: ProcessorRegistry,
  hooks: { onStuckHandler?: (info: StuckHandlerInfo) => void } = {},
): WorkerHost {
  return new WorkerHost({
    name: config.WORKER_NAME,
    redisUrl: config.REDIS_URL,
    prefix: config.QUEUE_PREFIX,
    queues: config.WORKER_QUEUES,
    registry,
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
