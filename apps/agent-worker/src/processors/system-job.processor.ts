import type { PrismaClient } from '@agentos/database';
import type { Logger } from '@agentos/logger';
import type { SystemJobQueuePayload } from '@agentos/contracts';

export interface ProcessorDeps {
  db: Pick<PrismaClient, 'systemJob'>;
  logger: Logger;
}

/**
 * Handles one `system-jobs` delivery.
 *
 * BullMQ delivers at-least-once (spec 8.4), so this handler is idempotent: it only
 * transitions jobs that are still QUEUED/RUNNING and does nothing for terminal ones.
 * A retried delivery (after a crash or thrown error) simply re-claims a RUNNING job.
 */
export async function processSystemJob(
  { db, logger }: ProcessorDeps,
  payload: SystemJobQueuePayload,
): Promise<void> {
  const log = logger.child({ jobId: payload.jobId, correlationId: payload.correlationId });

  const claimed = await db.systemJob.updateMany({
    where: { id: payload.jobId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    log.warn('System job is missing or already finished; skipping duplicate delivery');
    return;
  }

  const job = await db.systemJob.findUniqueOrThrow({ where: { id: payload.jobId } });
  const output = `pong: ${job.message}`;

  await db.systemJob.updateMany({
    where: { id: payload.jobId, status: 'RUNNING' },
    data: { status: 'COMPLETED', output, error: null, completedAt: new Date() },
  });
  log.info('System job completed');
}

/** Records terminal failure once BullMQ has exhausted all attempts. */
export async function markSystemJobFailed(
  { db, logger }: ProcessorDeps,
  payload: SystemJobQueuePayload,
  error: Error,
): Promise<void> {
  const { count } = await db.systemJob.updateMany({
    where: { id: payload.jobId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'FAILED', error: error.message.slice(0, 500), completedAt: new Date() },
  });
  logger.error(
    { jobId: payload.jobId, correlationId: payload.correlationId, updated: count },
    'System job failed permanently',
  );
}
