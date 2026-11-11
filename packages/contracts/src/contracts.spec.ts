import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_HEADER,
  apiErrorSchema,
  healthResponseSchema,
  idSchema,
  isoDateTimeSchema,
} from './index';

describe('contracts', () => {
  it('validates identifiers and timestamps', () => {
    expect(idSchema.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(idSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(isoDateTimeSchema.safeParse(new Date().toISOString()).success).toBe(true);
    expect(isoDateTimeSchema.safeParse('yesterday').success).toBe(false);
  });

  it('requires a correlation id in error bodies', () => {
    expect(apiErrorSchema.safeParse({ code: 'x', message: 'y', correlationId: 'c' }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ code: 'x', message: 'y' }).success).toBe(false);
  });

  it('parses the health response', () => {
    const body = { status: 'ok', service: 'api', uptimeSeconds: 1.5 };
    expect(healthResponseSchema.parse(body)).toEqual(body);
    expect(healthResponseSchema.safeParse({ ...body, status: 'down' }).success).toBe(false);
  });

  it('exposes a lowercase correlation header name', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });
});
