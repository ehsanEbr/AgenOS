import { Queue, type Worker } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  QUEUE_NAMES,
  SYSTEM_JOB_MAX_ATTEMPTS,
  SYSTEM_JOB_NAME,
  type SystemJobQueuePayload,
} from '@agentos/contracts';
import { createPrismaClient, type PrismaClient } from '@agentos/database';
import { createLogger } from '@agentos/logger';
import { createSystemJobsWorker } from '../src/system-jobs.worker';

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for condition');
}

describe('system-jobs worker (integration: PostgreSQL + Redis)', () => {
  let db: PrismaClient;
  let connection: IORedis;
  let queue: Queue<SystemJobQueuePayload>;
  let worker: Worker<SystemJobQueuePayload>;

  beforeAll(async () => {
    db = createPrismaClient(process.env.DATABASE_URL!);
    connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.SYSTEM_JOBS, { connection });
    worker = createSystemJobsWorker({
      connection,
      db,
      logger: createLogger({ service: 'test', level: 'silent' }),
      concurrency: 2,
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await db?.$disconnect();
    connection?.disconnect();
  });

  it('processes a queued job end to end and persists the result', async () => {
    const row = await db.systemJob.create({ data: { message: 'e2e', correlationId: 'int-worker' } });
    await queue.add(
      SYSTEM_JOB_NAME,
      { jobId: row.id, correlationId: 'int-worker' },
      { jobId: row.id, attempts: SYSTEM_JOB_MAX_ATTEMPTS },
    );

    const done = await waitFor(async () => {
      const current = await db.systemJob.findUniqueOrThrow({ where: { id: row.id } });
      return current.status === 'COMPLETED' ? current : undefined;
    });

    expect(done.output).toBe('pong: e2e');
    expect(done.attempts).toBe(1);
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
  });

  it('fails a malformed payload immediately without burning retries', async () => {
    const queueJobId = `malformed-${crypto.randomUUID()}`;
    await queue.add(SYSTEM_JOB_NAME, { jobId: 'not-a-uuid' } as unknown as SystemJobQueuePayload, {
      jobId: queueJobId,
      attempts: SYSTEM_JOB_MAX_ATTEMPTS,
    });

    const failed = await waitFor(async () => {
      if (!(await (await queue.getJob(queueJobId))?.isFailed())) return undefined;
      // Re-read so failedReason/attemptsMade reflect the final state.
      return queue.getJob(queueJobId);
    });
    expect(failed.failedReason).toContain('Invalid system job payload');
    expect(failed.attemptsMade).toBe(1);
    await failed.remove();
  });
});
