import { describe, expect, it } from 'vitest';
import { ConfigError, loadWorkerConfig } from './config';

const base = { REDIS_URL: 'redis://:s3cret-pw@127.0.0.1:6379' };

describe('loadWorkerConfig', () => {
  it('needs only REDIS_URL and applies documented defaults', () => {
    expect(loadWorkerConfig(base)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      QUEUE_PREFIX: 'agentos',
      WORKER_NAME: 'worker',
      WORKER_QUEUES: ['system'],
      WORKER_CONCURRENCY: 5,
      WORKER_JOB_TIMEOUT_MS: 60_000,
      WORKER_ABORT_GRACE_MS: 10_000,
      WORKER_SHUTDOWN_GRACE_MS: 30_000,
      WORKER_STARTUP_TIMEOUT_MS: 30_000,
      WORKER_LOCK_DURATION_MS: 30_000,
    });
  });

  it('parses numbers from text and the queue list from CSV', () => {
    const cfg = loadWorkerConfig({
      ...base,
      WORKER_CONCURRENCY: '20',
      WORKER_QUEUES: ' system ',
      WORKER_SHUTDOWN_GRACE_MS: '0',
      WORKER_NAME: 'worker-1',
      QUEUE_PREFIX: 'staging',
    });
    expect(cfg).toMatchObject({
      WORKER_CONCURRENCY: 20,
      WORKER_QUEUES: ['system'],
      WORKER_SHUTDOWN_GRACE_MS: 0,
      WORKER_NAME: 'worker-1',
      QUEUE_PREFIX: 'staging',
    });
  });

  it('requires REDIS_URL and rejects non-Redis schemes', () => {
    expect(() => loadWorkerConfig({})).toThrow(/REDIS_URL/);
    expect(() => loadWorkerConfig({ REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/);
  });

  it.each([
    ['unknown queue', { WORKER_QUEUES: 'system,agent-executions' }],
    ['duplicate queues', { WORKER_QUEUES: 'system,system' }],
    ['no queues', { WORKER_QUEUES: ' , ' }],
    ['zero concurrency', { WORKER_CONCURRENCY: '0' }],
    ['absurd concurrency', { WORKER_CONCURRENCY: '10000' }],
    ['non-numeric concurrency', { WORKER_CONCURRENCY: 'many' }],
    ['a job timeout under one second', { WORKER_JOB_TIMEOUT_MS: '10' }],
    ['a negative grace period', { WORKER_SHUTDOWN_GRACE_MS: '-1' }],
    ['an abort grace period under 100 ms', { WORKER_ABORT_GRACE_MS: '5' }],
    ['a non-numeric abort grace period', { WORKER_ABORT_GRACE_MS: 'soon' }],
    ['a lock duration under one second', { WORKER_LOCK_DURATION_MS: '5' }],
    ['an unsafe prefix', { QUEUE_PREFIX: 'a:b' }],
    ['an unsafe worker name', { WORKER_NAME: 'has space' }],
  ])('rejects %s', (_name, env) => {
    expect(() => loadWorkerConfig({ ...base, ...env })).toThrow(ConfigError);
  });

  it('names failing variables but never echoes secrets or bad values', () => {
    try {
      loadWorkerConfig({ REDIS_URL: 'http://user:s3cret-pw@host', WORKER_CONCURRENCY: 'leaky-value' });
      expect.unreachable();
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('WORKER_CONCURRENCY');
      expect(message).not.toContain('s3cret-pw');
      expect(message).not.toContain('leaky-value');
    }
  });
});
