import { describe, expect, it } from 'vitest';
import {
  CORRELATION_ID_HEADER,
  apiErrorSchema,
  healthResponseSchema,
  idSchema,
  isoDateTimeSchema,
  readinessResponseSchema,
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

  it('parses the liveness response', () => {
    const body = { status: 'ok', service: 'api', uptimeSeconds: 1.5 };
    expect(healthResponseSchema.parse(body)).toEqual(body);
    expect(healthResponseSchema.safeParse({ ...body, status: 'down' }).success).toBe(false);
  });

  it('exposes a lowercase correlation header name', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });
});

describe('readiness contract', () => {
  const up = { status: 'up', latencyMs: 3 };

  it('accepts ready and not_ready bodies', () => {
    expect(
      readinessResponseSchema.safeParse({ status: 'ready', checks: { postgres: up, redis: up } }).success,
    ).toBe(true);
    expect(
      readinessResponseSchema.safeParse({
        status: 'not_ready',
        checks: { postgres: { status: 'down', reason: 'timeout' }, redis: up },
      }).success,
    ).toBe(true);
  });

  it('restricts failure reasons to a fixed vocabulary (no free-form error text)', () => {
    const leaky = {
      status: 'not_ready',
      checks: {
        postgres: { status: 'down', reason: 'password authentication failed for user "agentos"' },
        redis: up,
      },
    };
    expect(readinessResponseSchema.safeParse(leaky).success).toBe(false);
  });

  it('requires both dependencies to be reported', () => {
    expect(readinessResponseSchema.safeParse({ status: 'ready', checks: { postgres: up } }).success).toBe(
      false,
    );
  });
});
