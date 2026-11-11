import { UnrecoverableError, Worker, type ConnectionOptions } from 'bullmq';
import type { PrismaClient } from '@agentos/database';
import type { Logger } from '@agentos/logger';
import { QUEUE_NAMES, systemJobQueuePayloadSchema, type SystemJobQueuePayload } from '@agentos/contracts';
import { markSystemJobFailed, processSystemJob } from './processors/system-job.processor';

export interface SystemJobsWorkerOptions {
  /** Must use `maxRetriesPerRequest: null` (BullMQ requirement for workers). */
  connection: ConnectionOptions;
  db: Pick<PrismaClient, 'systemJob'>;
  logger: Logger;
  concurrency: number;
}

export function createSystemJobsWorker({
  connection,
  db,
  logger,
  concurrency,
}: SystemJobsWorkerOptions): Worker<SystemJobQueuePayload> {
  const deps = { db, logger };

  const worker = new Worker<SystemJobQueuePayload>(
    QUEUE_NAMES.SYSTEM_JOBS,
    async (job) => {
      const parsed = systemJobQueuePayloadSchema.safeParse(job.data);
      // A malformed payload can never succeed, so do not burn retries on it.
      if (!parsed.success) throw new UnrecoverableError('Invalid system job payload');
      await processSystemJob(deps, parsed.data);
    },
    { connection, concurrency },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const exhausted = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn(
      { queueJobId: job.id, attemptsMade: job.attemptsMade, exhausted, err },
      'System job attempt failed',
    );
    if (!exhausted) return;

    const payload = systemJobQueuePayloadSchema.safeParse(job.data);
    if (!payload.success) return;
    markSystemJobFailed(deps, payload.data, err).catch((markErr: unknown) =>
      logger.error({ err: markErr }, 'Could not record system job failure'),
    );
  });

  worker.on('error', (err) => logger.error({ err }, 'Worker error'));

  return worker;
}
