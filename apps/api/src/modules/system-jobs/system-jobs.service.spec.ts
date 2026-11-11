import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service';
import type { SystemJobsQueue } from './system-jobs.queue';
import { SystemJobsService } from './system-jobs.service';

const now = new Date('2026-01-01T00:00:00.000Z');
const row = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  status: 'QUEUED' as const,
  message: 'hello',
  output: null,
  error: null,
  attempts: 0,
  correlationId: 'cid',
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  completedAt: null,
};

function setup(enqueue: () => Promise<void> = () => Promise.resolve()) {
  const systemJob = {
    create: vi.fn().mockResolvedValue(row),
    findUnique: vi.fn().mockResolvedValue(row),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const queue = { enqueue: vi.fn(enqueue) };
  const service = new SystemJobsService(
    { systemJob } as unknown as PrismaService,
    queue as unknown as SystemJobsQueue,
  );
  return { service, systemJob, queue };
}

describe('SystemJobsService', () => {
  it('persists the job, then enqueues a payload that only references it', async () => {
    const { service, systemJob, queue } = setup();
    const dto = await service.create({ message: 'hello' }, 'cid');

    expect(systemJob.create).toHaveBeenCalledWith({ data: { message: 'hello', correlationId: 'cid' } });
    expect(queue.enqueue).toHaveBeenCalledWith({ jobId: row.id, correlationId: 'cid' });
    expect(dto).toMatchObject({
      id: row.id,
      status: 'QUEUED',
      createdAt: now.toISOString(),
      startedAt: null,
    });
  });

  it('marks the job FAILED and returns 503 when enqueueing fails', async () => {
    const { service, systemJob } = setup(() => Promise.reject(new Error('redis down')));

    await expect(service.create({ message: 'hello' }, 'cid')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(systemJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, status: 'QUEUED' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('throws NotFound for unknown ids', async () => {
    const { service, systemJob } = setup();
    systemJob.findUnique.mockResolvedValue(null);
    await expect(service.get(row.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
