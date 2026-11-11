import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  QUEUE_NAMES,
  SYSTEM_JOB_MAX_ATTEMPTS,
  SYSTEM_JOB_NAME,
  type SystemJobQueuePayload,
} from '@agentos/contracts';
import { RedisService } from '../redis/redis.service';

/** Producer side of the `system-jobs` queue. The consumer lives in apps/agent-worker. */
@Injectable()
export class SystemJobsQueue implements OnModuleDestroy {
  private readonly queue: Queue<SystemJobQueuePayload>;

  constructor(redis: RedisService) {
    this.queue = new Queue<SystemJobQueuePayload>(QUEUE_NAMES.SYSTEM_JOBS, { connection: redis.client });
  }

  async enqueue(payload: SystemJobQueuePayload): Promise<void> {
    await this.queue.add(SYSTEM_JOB_NAME, payload, {
      // Using the persisted job id as the BullMQ job id de-duplicates accidental re-enqueues.
      jobId: payload.jobId,
      attempts: SYSTEM_JOB_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600 },
    });
  }

  async onModuleDestroy(): Promise<void> {
    // The Redis connection is owned (and closed) by RedisService.
    await this.queue.close();
  }
}
