import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readinessResponseSchema } from '@agentos/contracts';
import type { PrismaService } from '../database';
import type { RedisService } from '../redis';
import { DEPENDENCIES, HealthService, READINESS_TIMEOUT_MS } from './health.service';

type Check = () => Promise<void>;
const ok: Check = () => Promise.resolve();
const never: Check = () => new Promise(() => undefined);

function build(postgres: Check, redis: Check) {
  return new HealthService(
    { checkConnection: vi.fn(postgres) } as unknown as PrismaService,
    { checkConnection: vi.fn(redis) } as unknown as RedisService,
  );
}

describe('HealthService.checkReadiness', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is ready when PostgreSQL and Redis are up', async () => {
    const result = await build(ok, ok).checkReadiness();
    expect(result.status).toBe('ready');
    expect(result.checks.postgres.status).toBe('up');
    expect(result.checks.redis.status).toBe('up');
    expect(readinessResponseSchema.safeParse(result).success).toBe(true);
  });

  it('declares every known dependency as required (optional ones must be opted into explicitly)', () => {
    expect(DEPENDENCIES).toEqual({ postgres: { required: true }, redis: { required: true } });
  });

  it('is not ready when PostgreSQL is down, and says which dependency', async () => {
    const result = await build(() => Promise.reject(new Error('boom')), ok).checkReadiness();
    expect(result.status).toBe('not_ready');
    expect(result.checks.postgres).toEqual({ status: 'down', reason: 'unavailable' });
    expect(result.checks.redis.status).toBe('up');
  });

  it('is not ready when Redis is down', async () => {
    const result = await build(ok, () => Promise.reject(new Error('boom'))).checkReadiness();
    expect(result.status).toBe('not_ready');
    expect(result.checks.postgres.status).toBe('up');
    expect(result.checks.redis).toEqual({ status: 'down', reason: 'unavailable' });
  });

  it('is not ready when both are down', async () => {
    const fail: Check = () => Promise.reject(new Error('boom'));
    const result = await build(fail, fail).checkReadiness();
    expect(result.status).toBe('not_ready');
    expect(result.checks.postgres.status).toBe('down');
    expect(result.checks.redis.status).toBe('down');
  });

  it('times out a hanging dependency without waiting on it and without delaying the other probe', async () => {
    vi.useFakeTimers();
    const pending = build(never, ok).checkReadiness();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    const result = await pending;

    expect(result.status).toBe('not_ready');
    expect(result.checks.postgres).toEqual({ status: 'down', reason: 'timeout' });
    expect(result.checks.redis.status).toBe('up');
  });

  it('never exposes driver error text, hosts or credentials', async () => {
    const secretError = () =>
      Promise.reject(
        new Error('password authentication failed for postgresql://u:hunter2@db.internal:5432/app'),
      );
    const result = await build(secretError, secretError).checkReadiness();
    const body = JSON.stringify(result);
    expect(body).not.toMatch(/hunter2|db\.internal|password|postgresql:\/\//i);
  });
});
