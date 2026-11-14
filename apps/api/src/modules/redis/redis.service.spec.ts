import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config';

// Replace the ioredis driver with a controllable fake: these tests must not open sockets.
const fake = vi.hoisted(() => {
  class FakeRedis {
    static instances: FakeRedis[] = [];
    status = 'wait';
    handlers = new Map<string, (...args: unknown[]) => void>();
    connect = vi.fn(async () => {
      this.status = 'ready';
    });
    quit = vi.fn(async () => {
      this.status = 'end';
      return 'OK';
    });
    disconnect = vi.fn(() => {
      this.status = 'end';
    });
    ping = vi.fn(async () => 'PONG');
    constructor(
      public url: string,
      public options: Record<string, unknown>,
    ) {
      FakeRedis.instances.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }
  }
  return { FakeRedis };
});
vi.mock('ioredis', () => ({ default: fake.FakeRedis }));

import { RedisService } from './redis.service';

const config = { REDIS_URL: 'redis://:very-secret@127.0.0.1:1' } as ApiConfig;

describe('RedisService', () => {
  let service: RedisService;
  let client: InstanceType<typeof fake.FakeRedis>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake.FakeRedis.instances.length = 0;
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new RedisService(config);
    client = fake.FakeRedis.instances[0]!;
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a lazy, fail-fast client from the validated URL', () => {
    expect(client.url).toBe(config.REDIS_URL);
    expect(client.options).toMatchObject({ lazyConnect: true, maxRetriesPerRequest: 1 });
  });

  it('connects on module init', async () => {
    await service.onModuleInit();
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it('does not fail startup when Redis is unreachable, and never logs credentials', async () => {
    client.connect.mockRejectedValue(new Error('connect ECONNREFUSED redis://:very-secret@127.0.0.1:1'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('very-secret');
  });

  it('logs an outage once, not once per retry', () => {
    const onError = client.handlers.get('error')!;
    onError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    onError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
  });

  it('quits gracefully when connected', async () => {
    client.status = 'ready';
    await service.onModuleDestroy();
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('hard-closes when not connected (no hanging on shutdown)', async () => {
    client.status = 'reconnecting';
    await service.onModuleDestroy();
    expect(client.quit).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('falls back to a hard close if quit fails', async () => {
    client.status = 'ready';
    client.quit.mockRejectedValue(new Error('Connection is closed.'));
    await service.onModuleDestroy();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('checkConnection requires a PONG', async () => {
    await expect(service.checkConnection()).resolves.toBeUndefined();

    client.ping.mockResolvedValue('nope');
    await expect(service.checkConnection()).rejects.toThrow('Unexpected reply');

    client.ping.mockRejectedValue(new Error('Connection is closed.'));
    await expect(service.checkConnection()).rejects.toThrow('closed');
  });
});
