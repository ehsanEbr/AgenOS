import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config';
import { PrismaService } from './prisma.service';

const config = {
  DATABASE_URL: 'postgresql://user:very-secret@127.0.0.1:1/app?schema=public',
} as ApiConfig;

describe('PrismaService', () => {
  let service: PrismaService;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new PrismaService(config); // constructing a client never opens a connection
  });

  afterEach(() => vi.restoreAllMocks());

  it('connects on module init', async () => {
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);
    await service.onModuleInit();
    expect(connect).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not fail startup when PostgreSQL is unreachable, and never logs credentials', async () => {
    vi.spyOn(service, '$connect').mockRejectedValue(
      new Error("Can't reach database server at postgresql://user:very-secret@127.0.0.1:1"),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('very-secret');
  });

  it('disconnects on module destroy', async () => {
    const disconnect = vi.spyOn(service, '$disconnect').mockResolvedValue(undefined);
    await service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('completes shutdown even if disconnect fails (database never connected)', async () => {
    vi.spyOn(service, '$disconnect').mockRejectedValue(
      new Error("Can't reach database server at postgresql://user:very-secret@127.0.0.1:1"),
    );
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('very-secret');
  });

  it('checkConnection issues a trivial query and propagates failures', async () => {
    const query = vi.spyOn(service, '$queryRaw').mockResolvedValue([{ '?column?': 1 }] as never);
    await expect(service.checkConnection()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();

    query.mockRejectedValue(new Error('connection refused'));
    await expect(service.checkConnection()).rejects.toThrow('connection refused');
  });
});
