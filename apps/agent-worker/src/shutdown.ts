import type { Logger } from '@agentos/logger';

export interface ShutdownOptions {
  /** Stops accepting new work and resolves once in-flight jobs finish (BullMQ `Worker.close`). */
  drain: () => Promise<void>;
  /** Releases connections after draining (database, Redis). */
  cleanup: () => Promise<void>;
  logger: Logger;
  exit: (code: number) => void;
  timeoutMs: number;
}

/**
 * Returns an idempotent shutdown function: repeated signals are ignored, and a hard timeout
 * guarantees the process exits even if a job never finishes.
 */
export function createShutdownHandler({ drain, cleanup, logger, exit, timeoutMs }: ShutdownOptions) {
  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    if (started) return;
    started = true;
    logger.info({ signal }, 'Shutting down: waiting for in-flight jobs');

    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      exit(1);
    }, timeoutMs);
    timer.unref();

    try {
      await drain();
      await cleanup();
      clearTimeout(timer);
      logger.info('Shutdown complete');
      exit(0);
    } catch (err) {
      clearTimeout(timer);
      logger.error({ err }, 'Error during shutdown');
      exit(1);
    }
  };
}
