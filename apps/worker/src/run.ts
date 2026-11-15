import { redactUrl } from '@agentos/config';
import { createLogger } from '@agentos/logger';
import { createWorkerHost } from './app';
import { ConfigError, loadWorkerConfig } from './config';
import { HealthFile } from './health';
import { type ProcessorRegistry, StartupError } from './runtime';

/**
 * Process exit codes (supervisors and tests rely on them):
 *   0  clean shutdown: every active job finished within the grace period
 *   1  runtime failure: startup failed, a fatal error occurred, a handler is stuck, or shutdown had to abandon running jobs
 *   2  invalid configuration (nothing was started)
 */
export const EXIT = { ok: 0, failure: 1, invalidConfig: 2 } as const;

/**
 * The worker process: configuration, signals, health reporting, exit codes. `main.ts` calls it with the production registry;
 * tests call it with their own so the REAL entry-point behavior (stuck handler -> shutdown -> exit 1) can be verified without
 * putting test processors into the production registry.
 */
export async function runWorker({ registry }: { registry: ProcessorRegistry }): Promise<void> {
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // The message names variables, never values, so it is safe to print.
    process.stderr.write(`${error.message}\n`);
    process.exit(EXIT.invalidConfig);
  }

  const logger = createLogger({
    service: 'worker',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  }).child({ worker: config.WORKER_NAME });

  logger.info(
    {
      redis: redactUrl(config.REDIS_URL),
      queues: config.WORKER_QUEUES,
      prefix: config.QUEUE_PREFIX,
      pid: process.pid,
      node: process.version,
      healthFile: config.WORKER_HEALTH_FILE !== undefined,
    },
    'worker starting',
  );

  // Signals are handled from the very first moment, so a SIGTERM during startup also shuts down cleanly.
  let shuttingDown = false;
  const shutdown = async (signal: string, alwaysFail = false): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal received; exiting immediately');
      process.exit(EXIT.failure);
    }
    shuttingDown = true;
    const stopping = host.stop(signal);
    health?.refresh(); // stop() has already left `running`: a draining worker is not ready, and says so at once
    const result = await stopping;
    health?.stop();
    process.exit(result.forced || alwaysFail ? EXIT.failure : EXIT.ok);
  };
  // A handler that ignores its AbortSignal cannot be stopped from inside the process, and the runtime refuses to retry its job
  // beside it. Restarting the process is the one thing that really ends it: shut down (other jobs get the grace period; the
  // stuck job is left unacknowledged and is redelivered after its lock expires) and exit non-zero for the supervisor.
  const host = createWorkerHost(config, logger, registry, {
    onStuckHandler: (info) => {
      logger.fatal({ ...info }, 'a handler is stuck after its timeout; restarting the worker process');
      if (!shuttingDown) void shutdown('stuck-handler', true); // always a failure exit: something is wrong with a processor
    },
  });
  const health =
    config.WORKER_HEALTH_FILE === undefined
      ? undefined
      : new HealthFile(config.WORKER_HEALTH_FILE, host, logger);

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Nothing in normal operation reaches these: job errors are contained by BullMQ and the dispatcher. If one does fire the
  // process state cannot be trusted, so log it, try a short shutdown and exit non-zero for the supervisor to restart.
  const fatal = (error: unknown, origin: string): void => {
    logger.fatal({ err: error, origin }, 'unexpected error; shutting down');
    void Promise.race([
      host.stop('fatal-error'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).finally(() => {
      health?.stop();
      process.exit(EXIT.failure);
    });
  };
  process.on('uncaughtException', (error) => fatal(error, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => fatal(reason, 'unhandledRejection'));

  health?.start(); // visible from the first moment: "starting, not ready" until Redis is connected
  try {
    await host.start();
  } catch (error) {
    if (shuttingDown) return; // a signal arrived while starting; the shutdown handler is already exiting
    logger.fatal(
      { reason: error instanceof StartupError ? error.message : 'unexpected startup error' },
      'worker failed to start',
    );
    health?.stop();
    process.exit(EXIT.failure);
  }
  health?.refresh(); // report "running, ready" now rather than at the next heartbeat
}
