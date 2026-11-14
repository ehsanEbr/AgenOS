import { HttpException, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, type AppErrorKind, HTTP_STATUS_BY_ERROR_KIND } from './app-error';
import { classifyError, toApiError } from './api-error';
import { type CorrelatedRequest, correlationIdMiddleware } from './correlation-id.middleware';
import { ZodValidationPipe, createZodDto } from './zod-validation.pipe';

function runMiddleware(header?: string) {
  const req = { headers: header === undefined ? {} : { 'x-correlation-id': header } } as unknown as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  correlationIdMiddleware(req, res, next);
  return { id: (req as CorrelatedRequest).correlationId, res, next };
}

describe('correlationIdMiddleware', () => {
  it('generates an id when none is supplied and echoes it in the response', () => {
    const { id, res, next } = runMiddleware();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', id);
    expect(next).toHaveBeenCalled();
  });

  it('reuses a well-formed incoming id', () => {
    expect(runMiddleware('abc-123_XYZ.1').id).toBe('abc-123_XYZ.1');
  });

  it('replaces malformed ids (log injection guard)', () => {
    expect(runMiddleware('bad id\nwith newline').id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AppError', () => {
  const kinds = Object.keys(HTTP_STATUS_BY_ERROR_KIND) as AppErrorKind[];

  it.each(kinds)('maps kind "%s" to its HTTP status', (kind) => {
    const { status, body } = toApiError(new AppError(kind, 'some_code', 'Safe message'), 'cid');
    expect(status).toBe(HTTP_STATUS_BY_ERROR_KIND[kind]);
    expect(body).toEqual({ code: 'some_code', message: 'Safe message', correlationId: 'cid' });
  });

  it('carries client-safe details but never the cause', () => {
    const cause = new Error('SELECT * FROM secrets WHERE token = hunter2');
    const { body } = toApiError(
      new AppError('conflict', 'name_taken', 'Name already in use', { details: { field: 'name' }, cause }),
      'cid',
    );
    expect(body.details).toEqual({ field: 'name' });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});

describe('toApiError / classifyError', () => {
  it('maps HttpExceptions with structured bodies', () => {
    const { status, body } = toApiError(
      new NotFoundException({ code: 'thing_missing', message: 'nope' }),
      'cid',
    );
    expect(status).toBe(404);
    expect(body).toEqual({ code: 'thing_missing', message: 'nope', correlationId: 'cid' });
  });

  it('falls back to a status-derived code', () => {
    expect(toApiError(new HttpException('teapot', 418), 'cid').body.code).toBe('http_418');
    expect(toApiError(new NotFoundException(), 'cid').body.code).toBe('not_found');
  });

  it('never leaks the message of unexpected errors', () => {
    const { status, body } = toApiError(new Error('connection string postgres://secret'), 'cid');
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'internal_error', message: 'Internal server error', correlationId: 'cid' });
  });

  it('distinguishes application errors from unexpected ones', () => {
    expect(classifyError(new AppError('not_found', 'x', 'y'))).toBe('application');
    expect(classifyError(new NotFoundException())).toBe('http');
    expect(classifyError(new Error('boom'))).toBe('unexpected');
    expect(classifyError('a string')).toBe('unexpected');
  });
});

describe('ZodValidationPipe', () => {
  class Dto extends createZodDto(z.object({ message: z.string().trim().min(1) })) {}
  const pipe = new ZodValidationPipe();
  const meta = { type: 'body' as const, metatype: Dto };

  it('returns parsed data for DTO-typed parameters', () => {
    expect(pipe.transform({ message: ' hello ' }, meta)).toEqual({ message: 'hello' });
  });

  it('throws a validation AppError with per-field details', () => {
    try {
      pipe.transform({ message: '' }, meta);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const error = e as AppError;
      expect(error.kind).toBe('validation');
      expect(error.code).toBe('validation_error');
      expect(error.details).toHaveLength(1);
    }
  });

  it('passes through parameters without a DTO type', () => {
    expect(pipe.transform('raw', { type: 'param', metatype: String })).toBe('raw');
    expect(pipe.transform('raw', { type: 'param' })).toBe('raw');
  });
});
