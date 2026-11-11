import { describe, expect, it } from 'vitest';
import {
  QUEUE_NAMES,
  createSystemJobRequestSchema,
  readinessResponseSchema,
  systemJobQueuePayloadSchema,
} from './index';

describe('contracts', () => {
  it('trims and validates system job requests', () => {
    expect(createSystemJobRequestSchema.parse({ message: '  hi  ' })).toEqual({ message: 'hi' });
    expect(createSystemJobRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(createSystemJobRequestSchema.safeParse({ message: 'x'.repeat(201) }).success).toBe(false);
  });

  it('requires a uuid job id in the queue payload', () => {
    expect(systemJobQueuePayloadSchema.safeParse({ jobId: 'nope', correlationId: 'c' }).success).toBe(false);
    expect(
      systemJobQueuePayloadSchema.safeParse({ jobId: crypto.randomUUID(), correlationId: 'c' }).success,
    ).toBe(true);
  });

  it('parses readiness responses', () => {
    const parsed = readinessResponseSchema.parse({
      status: 'degraded',
      checks: { database: { status: 'down', error: 'timeout' }, redis: { status: 'up', latencyMs: 2 } },
    });
    expect(parsed.checks.database?.status).toBe('down');
  });

  it('keeps queue names unique', () => {
    const names = Object.values(QUEUE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });
});
