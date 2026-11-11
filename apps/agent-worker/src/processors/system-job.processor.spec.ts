import { describe, expect, it, vi } from 'vitest';
import { markSystemJobFailed, processSystemJob, type ProcessorDeps } from './system-job.processor';

const payload = { jobId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', correlationId: 'cid' };

function fakeDeps(initialStatus: string | null) {
  // Minimal in-memory stand-in for the system_jobs table.
  const state = {
    row: initialStatus
      ? { status: initialStatus, message: 'hi', attempts: 0, output: null as string | null }
      : null,
  };
  const systemJob = {
    updateMany: vi.fn(
      async ({ where, data }: { where: { status: unknown }; data: Record<string, unknown> }) => {
        const row = state.row;
        const allowed =
          typeof where.status === 'string' ? [where.status] : (where.status as { in: string[] }).in;
        if (!row || !allowed.includes(row.status)) return { count: 0 };
        if (data.status) row.status = data.status as string;
        if (typeof data.output === 'string') row.output = data.output;
        if (data.attempts) row.attempts += 1;
        return { count: 1 };
      },
    ),
    findUniqueOrThrow: vi.fn(async () => state.row),
  };
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { state, systemJob, deps: { db: { systemJob }, logger } as unknown as ProcessorDeps };
}

describe('processSystemJob', () => {
  it('completes a queued job', async () => {
    const { state, deps } = fakeDeps('QUEUED');
    await processSystemJob(deps, payload);
    expect(state.row).toMatchObject({ status: 'COMPLETED', output: 'pong: hi', attempts: 1 });
  });

  it('is idempotent: a duplicate delivery of a finished job changes nothing', async () => {
    const { state, systemJob, deps } = fakeDeps('QUEUED');
    await processSystemJob(deps, payload);
    await processSystemJob(deps, payload);
    expect(state.row?.attempts).toBe(1);
    expect(systemJob.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it('skips jobs that no longer exist', async () => {
    const { systemJob, deps } = fakeDeps(null);
    await expect(processSystemJob(deps, payload)).resolves.toBeUndefined();
    expect(systemJob.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('markSystemJobFailed', () => {
  it('fails unfinished jobs but never overwrites a completed one', async () => {
    const running = fakeDeps('RUNNING');
    await markSystemJobFailed(running.deps, payload, new Error('boom'));
    expect(running.state.row?.status).toBe('FAILED');

    const done = fakeDeps('COMPLETED');
    await markSystemJobFailed(done.deps, payload, new Error('boom'));
    expect(done.state.row?.status).toBe('COMPLETED');
  });
});
