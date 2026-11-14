import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JOB_TYPE_PATTERN,
  QUEUE_NAMES,
  defineJob,
  isQueueName,
  jobEnvelopeSchema,
  jobTypeSchema,
  systemPingJob,
} from './index';

const valid = {
  type: 'system.ping',
  version: 1,
  correlationId: 'req-123.abc_DEF',
  createdAt: '2026-01-01T00:00:00.000Z',
  payload: { anything: true },
};

describe('jobEnvelopeSchema', () => {
  it('accepts a complete envelope and leaves the payload untouched', () => {
    expect(jobEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it('ignores unknown extra fields (forward compatibility)', () => {
    expect(jobEnvelopeSchema.parse({ ...valid, addedLater: 1 })).toEqual(valid);
  });

  it.each([
    ['missing type', { ...valid, type: undefined }],
    ['uppercase type', { ...valid, type: 'System.Ping' }],
    ['type without an action', { ...valid, type: 'ping' }],
    ['version 0', { ...valid, version: 0 }],
    ['fractional version', { ...valid, version: 1.5 }],
    ['correlation id with spaces/newlines (log injection)', { ...valid, correlationId: 'a b\nc' }],
    ['empty correlation id', { ...valid, correlationId: '' }],
    ['non-ISO timestamp', { ...valid, createdAt: 'yesterday' }],
  ])('rejects %s', (_name, input) => {
    expect(jobEnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it('rejects things that are not objects', () => {
    for (const input of [null, 'job', 42, [], undefined])
      expect(jobEnvelopeSchema.safeParse(input).success).toBe(false);
  });
});

describe('job types and queues', () => {
  it('validates the <area>.<action> pattern', () => {
    expect(jobTypeSchema.safeParse('agent.execute').success).toBe(true);
    expect(jobTypeSchema.safeParse('repository.index_full').success).toBe(true);
    expect(jobTypeSchema.safeParse('x'.repeat(101)).success).toBe(false);
    expect(JOB_TYPE_PATTERN.test('a.b.c')).toBe(true);
  });

  it('knows its queues', () => {
    expect(isQueueName(QUEUE_NAMES.system)).toBe(true);
    expect(isQueueName('agent-executions')).toBe(false); // arrives with its domain phase
    expect(isQueueName(undefined)).toBe(false);
  });
});

describe('defineJob', () => {
  it('returns the definition', () => {
    const job = defineJob({ queue: 'system', type: 'system.noop', version: 2, payload: z.object({}) });
    expect(job.version).toBe(2);
  });

  it('rejects an invalid type or version at definition time', () => {
    expect(() => defineJob({ queue: 'system', type: 'Bad', version: 1, payload: z.object({}) })).toThrow(
      /Invalid job type/,
    );
    expect(() =>
      defineJob({ queue: 'system', type: 'system.noop', version: 0, payload: z.object({}) }),
    ).toThrow(/version/);
  });
});

describe('systemPingJob', () => {
  it('applies defaults and bounds the simulated delay', () => {
    expect(systemPingJob.payload.parse({})).toEqual({ delayMs: 0 });
    expect(systemPingJob.payload.safeParse({ delayMs: 60_001 }).success).toBe(false);
    expect(systemPingJob.payload.safeParse({ delayMs: -1 }).success).toBe(false);
    expect(systemPingJob.payload.safeParse({ message: 'x'.repeat(201) }).success).toBe(false);
  });
});
