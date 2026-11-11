import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toApiError } from './api-error';
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

describe('toApiError', () => {
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
});

describe('ZodValidationPipe', () => {
  class Dto extends createZodDto(z.object({ message: z.string().trim().min(1) })) {}
  const pipe = new ZodValidationPipe();
  const meta = { type: 'body' as const, metatype: Dto };

  it('returns parsed data for DTO-typed parameters', () => {
    expect(pipe.transform({ message: ' hello ' }, meta)).toEqual({ message: 'hello' });
  });

  it('throws a structured validation error', () => {
    try {
      pipe.transform({ message: '' }, meta);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const response = (e as BadRequestException).getResponse() as { code: string; details: unknown[] };
      expect(response.code).toBe('validation_error');
      expect(response.details).toHaveLength(1);
    }
  });

  it('passes through parameters without a DTO type', () => {
    expect(pipe.transform('raw', { type: 'param', metatype: String })).toBe('raw');
    expect(pipe.transform('raw', { type: 'param' })).toBe('raw');
  });
});
