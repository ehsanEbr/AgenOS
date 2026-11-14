import { redactUrl } from '@agentos/config';
import { createLogger } from '@agentos/logger';
import { createWorkerHost } from './app';
import { ConfigError, loadWorkerConfig } from './config';
import { StartupError } from './runtime';

/**
 * Process exit codes (supervisors and tests rely on them):
 *   0  clean shutdown: every active job finished within the grace period
 *   1  runtime failure: startup failed, a fatal error occurred, or shutdown had to abandon running jobs
 *   2  invalid configuration (nothing was started)
 */
const EXIT = { ok: 0, failure: 1, invalidConfig: 2 } as const;

async function main(): Promise<void> {
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
    const result = await host.stop(signal);
    process.exit(result.forced || alwaysFail ? EXIT.failure : EXIT.ok);
  };
  // A handler that ignores its AbortSignal cannot be stopped from inside the process, and the runtime refuses to retry its job
  // beside it. Restarting the process is the one thing that really ends it: shut down (other jobs get the grace period; the
  // stuck job is left unacknowledged and is redelivered after its lock expires) and exit non-zero for the supervisor.
  const host = createWorkerHost(config, logger, {
    onStuckHandler: (info) => {
      logger.fatal({ ...info }, 'a handler is stuck after its timeout; restarting the worker process');
      if (!shuttingDown) void shutdown('stuck-handler', true); // always a failure exit: something is wrong with a processor
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Nothing in normal operation reaches these: job errors are contained by BullMQ and the dispatcher. If one does fire the
  // process state cannot be trusted, so log it, try a short shutdown and exit non-zero for the supervisor to restart.
  const fatal = (error: unknown, origin: string): void => {
    logger.fatal({ err: error, origin }, 'unexpected error; shutting down');
    void Promise.race([
      host.stop('fatal-error'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]).finally(() => process.exit(EXIT.failure));
  };
  process.on('uncaughtException', (error) => fatal(error, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => fatal(reason, 'unhandledRejection'));

  try {
    await host.start();
  } catch (error) {
    if (shuttingDown) return; // a signal arrived while starting; the shutdown handler is already exiting
    logger.fatal(
      { reason: error instanceof StartupError ? error.message : 'unexpected startup error' },
      'worker failed to start',
    );
    process.exit(EXIT.failure);
  }
}

void main();
