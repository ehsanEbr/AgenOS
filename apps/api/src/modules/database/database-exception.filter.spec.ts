import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseExceptionFilter } from './database-exception.filter';

function host() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { correlationId: 'cid-9' };
  const argumentsHost = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { argumentsHost, status, json };
}

describe('DatabaseExceptionFilter', () => {
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('answers 503 database_unavailable (a warning, not an error) when the database cannot be reached', () => {
    const { argumentsHost, status, json } = host();
    new DatabaseExceptionFilter().catch(
      new Prisma.PrismaClientInitializationError(
        "Can't reach database server at postgresql://u:hunter2@db:5432",
        'test',
      ),
      argumentsHost,
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      code: 'database_unavailable',
      message: 'The database is temporarily unavailable. Please retry.',
      correlationId: 'cid-9',
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('answers a generic 500 for other Prisma errors and never exposes or logs Prisma message text', () => {
    const { argumentsHost, status, json } = host();
    const sensitive = 'Invalid `prisma.user.create()` invocation: data: { passwordHash: "hunter2" }';
    new DatabaseExceptionFilter().catch(
      new Prisma.PrismaClientKnownRequestError(sensitive, { code: 'P2002', clientVersion: 'test' }),
      argumentsHost,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'internal_error',
      message: 'Internal server error',
      correlationId: 'cid-9',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('hunter2');
    // the log carries the error class and Prisma code only
    expect(JSON.stringify(error.mock.calls)).not.toContain('hunter2');
    expect(JSON.stringify(error.mock.calls)).toContain('PrismaClientKnownRequestError P2002');
  });
});
