import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { SystemJob as SystemJobRow } from '@agentos/database';
import type { CreateSystemJobRequest, SystemJob } from '@agentos/contracts';
import { PrismaService } from '../database/prisma.service';
import { SystemJobsQueue } from './system-jobs.queue';

export function toSystemJobDto(row: SystemJobRow): SystemJob {
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    output: row.output,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class SystemJobsService {
  private readonly logger = new Logger(SystemJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: SystemJobsQueue,
  ) {}

  async create(request: CreateSystemJobRequest, correlationId: string): Promise<SystemJob> {
    const row = await this.prisma.systemJob.create({
      data: { message: request.message, correlationId },
    });

    try {
      await this.queue.enqueue({ jobId: row.id, correlationId });
    } catch (err) {
      // TODO(outbox): replace with the transactional outbox (spec 11.4) once domain events land,
      // so a lost enqueue can be retried instead of failing the job.
      this.logger.error({ correlationId, jobId: row.id, err }, 'Failed to enqueue system job');
      await this.prisma.systemJob
        .updateMany({
          where: { id: row.id, status: 'QUEUED' },
          data: { status: 'FAILED', error: 'Failed to enqueue job', completedAt: new Date() },
        })
        .catch(() => undefined);
      throw new ServiceUnavailableException({
        code: 'queue_unavailable',
        message: 'The job queue is currently unavailable',
      });
    }

    return toSystemJobDto(row);
  }

  async get(id: string): Promise<SystemJob> {
    const row = await this.prisma.systemJob.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'job_not_found', message: `System job ${id} was not found` });
    }
    return toSystemJobDto(row);
  }
}
