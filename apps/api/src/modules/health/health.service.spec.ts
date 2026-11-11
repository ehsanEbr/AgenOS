import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../database/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { HealthService } from './health.service';

function build(db: () => Promise<unknown>, redis: () => Promise<void>) {
  return new HealthService(
    { $queryRaw: vi.fn(db) } as unknown as PrismaService,
    { ping: vi.fn(redis) } as unknown as RedisService,
  );
}

describe('HealthService', () => {
  it('reports ok when all dependencies are up', async () => {
    const result = await build(
      () => Promise.resolve([{ '?column?': 1 }]),
      () => Promise.resolve(),
    ).check();
    expect(result.status).toBe('ok');
    expect(result.checks.database?.status).toBe('up');
    expect(result.checks.redis?.status).toBe('up');
  });

  it('reports degraded without leaking error details', async () => {
    const result = await build(
      () => Promise.reject(new Error('password authentication failed for user "agentos"')),
      () => Promise.resolve(),
    ).check();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toEqual({ status: 'down', error: 'unreachable' });
    expect(JSON.stringify(result)).not.toContain('password');
  });
});
