import { describe, expect, it, vi } from 'vitest';
import { createRedisConnection, reconnectDelay } from './connection';
import { QUEUES, queuePrefixSchema } from './definitions';
import {
  DEFAULT_RETENTION,
  DEFAULT_RETRY_POLICY,
  MAX_ATTEMPTS,
  retryPolicySchema,
  toJobOptions,
} from './retry';

describe('retry policy', () => {
  it('defaults to three attempts with jittered exponential backoff', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ attempts: 3, backoffMs: 1_000, jitter: 0.5 });
    expect(retryPolicySchema.safeParse(DEFAULT_RETRY_POLICY).success).toBe(true);
  });

  it('translates to BullMQ options with bounded retention', () => {
    expect(toJobOptions(DEFAULT_RETRY_POLICY)).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
      removeOnComplete: DEFAULT_RETENTION.completed,
      removeOnFail: DEFAULT_RETENTION.failed,
    });
  });

  it('keeps failed jobs long enough to be inspected, and never forever', () => {
    const options = toJobOptions(DEFAULT_RETRY_POLICY);
    expect(options.removeOnFail).toMatchObject({ age: 604_800, count: 5_000 });
  });

  it.each([
    ['no attempts', { attempts: 0 }],
    ['more attempts than the cap (infinite-retry guard)', { attempts: MAX_ATTEMPTS + 1 }],
    ['fractional attempts', { attempts: 2.5 }],
    ['a zero-delay retry loop', { backoffMs: 0 }],
    ['jitter above 1', { jitter: 1.5 }],
    ['negative jitter', { jitter: -0.1 }],
    ['a worst-case wait above one hour', { attempts: 10, backoffMs: 300_000 }],
  ])('rejects %s', (_name, override) => {
    expect(retryPolicySchema.safeParse({ ...DEFAULT_RETRY_POLICY, ...override }).success).toBe(false);
    expect(() => toJobOptions({ ...DEFAULT_RETRY_POLICY, ...override })).toThrow();
  });

  it('accepts the largest policy whose longest wait is still within an hour', () => {
    expect(retryPolicySchema.safeParse({ attempts: 10, backoffMs: 10_000, jitter: 1 }).success).toBe(true);
  });
});

describe('queue registry and prefix', () => {
  it('defines the system queue with the default retry policy', () => {
    expect(QUEUES.system).toEqual({ name: 'system', retry: DEFAULT_RETRY_POLICY });
  });

  it('accepts safe prefixes only', () => {
    expect(queuePrefixSchema.safeParse('agentos').success).toBe(true);
    expect(queuePrefixSchema.safeParse('it-1a2b_3').success).toBe(true);
    for (const bad of ['', 'has space', 'a:b', '-leading', 'x'.repeat(65)])
      expect(queuePrefixSchema.safeParse(bad).success).toBe(false);
  });
});

describe('createRedisConnection', () => {
  const closedPort = 'redis://:pw@127.0.0.1:1';

  it('makes worker connections wait for Redis and producer connections fail fast', () => {
    const worker = createRedisConnection(closedPort, { role: 'worker', name: 'w' });
    const producer = createRedisConnection(closedPort, { role: 'producer', name: 'p' });
    try {
      expect(worker.options.maxRetriesPerRequest).toBeNull(); // required by BullMQ workers
      expect(producer.options.maxRetriesPerRequest).toBe(2);
      expect(worker.options.connectionName).toBe('w');
    } finally {
      worker.disconnect();
      producer.disconnect();
    }
  });

  it('reports connection errors to the caller instead of printing them', async () => {
    const onError = vi.fn();
    const connection = createRedisConnection(closedPort, { role: 'producer', name: 'p', onError });
    try {
      await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5_000 });
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      connection.disconnect();
    }
  });

  it('reconnects forever with a capped delay', () => {
    expect([1, 2, 10, 25, 1000].map(reconnectDelay)).toEqual([200, 400, 2_000, 5_000, 5_000]);
  });
});
