import IORedis from 'ioredis';
import { loadWorkerConfig } from '@agentos/config';
import { createPrismaClient } from '@agentos/database';
import { createLogger } from '@agentos/logger';
import { createShutdownHandler } from './shutdown';
import { createSystemJobsWorker } from './system-jobs.worker';

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger({
    service: 'agent-worker',
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });

  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.error({ err }, 'Redis connection error'));
  const db = createPrismaClient(config.DATABASE_URL);

  const worker = createSystemJobsWorker({
    connection,
    db,
    logger,
    concurrency: config.WORKER_CONCURRENCY,
  });
  await worker.waitUntilReady();
  logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Worker ready');

  const shutdown = createShutdownHandler({
    drain: () => worker.close(), // stops fetching new jobs, waits for active ones
    cleanup: async () => {
      await db.$disconnect();
      connection.disconnect();
    },
    logger,
    exit: (code) => process.exit(code),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
