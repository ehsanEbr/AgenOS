import { Writable } from 'node:stream';
import { baseLoggerOptions, type Logger } from '@agentos/logger';
import {
  type QueueProducer as Producer,
  QueueProducer,
  createRedisConnection,
  type Redis,
} from '@agentos/queue';
import { Queue } from 'bullmq';
import pino from 'pino';
import { WorkerHost, type WorkerHostOptions } from '../../src/runtime';
import { testRedisUrl, uniquePrefix } from './env';
import { Controls, createTestRegistry } from './test-processors';

export interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** A real pino logger (same options as production) that keeps every JSON line, so tests assert on what is actually logged. */
export function createLogCapture(): { logger: Logger; lines: LogLine[]; text: () => string } {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as LogLine);
      callback();
    },
  });
  const logger = pino(baseLoggerOptions({ service: 'worker', level: 'debug' }), stream).child({
    worker: 'test',
  });
  return { logger, lines, text: () => JSON.stringify(lines) };
}

export const FAST_RETRY = { attempts: 3, backoffMs: 100, jitter: 0 } as const;

export type HostOverrides = Partial<Omit<WorkerHostOptions, 'registry' | 'logger' | 'prefix'>>;

/**
 * Everything one test needs, isolated by a unique Redis prefix: a producer, a raw BullMQ queue handle for inspection, the
 * controllable test processors, captured logs, and a factory for worker hosts. `close()` stops every host and deletes the
 * test's Redis keys.
 */
export class Harness {
  readonly prefix = uniquePrefix();
  readonly controls = new Controls();
  readonly capture = createLogCapture();
  readonly producer: Producer;
  readonly queue: Queue;
  private readonly connection: Redis;
  private readonly hosts: WorkerHost[] = [];

  constructor(redisUrl: string = testRedisUrl()) {
    this.connection = createRedisConnection(redisUrl, { role: 'producer', name: 'it-producer' });
    this.producer = new QueueProducer({ connection: this.connection, prefix: this.prefix });
    this.queue = new Queue('system', { connection: this.connection, prefix: this.prefix });
    this.queue.on('error', () => undefined);
  }

  get lines(): LogLine[] {
    return this.capture.lines;
  }

  /** Creates (but does not start) a host with fast, test-friendly timings. */
  createHost(overrides: HostOverrides = {}): WorkerHost {
    const host = new WorkerHost({
      name: 'it-worker',
      redisUrl: testRedisUrl(),
      queues: ['system'],
      concurrency: 2,
      jobTimeoutMs: 10_000,
      shutdownGraceMs: 5_000,
      lockDurationMs: 1_000,
      startupTimeoutMs: 10_000,
      ...overrides,
      prefix: this.prefix,
      registry: createTestRegistry(this.controls),
      logger: this.capture.logger,
    });
    this.hosts.push(host);
    return host;
  }

  async startHost(overrides: HostOverrides = {}): Promise<WorkerHost> {
    const host = this.createHost(overrides);
    await host.start();
    return host;
  }

  async jobState(jobId: string): Promise<string> {
    const job = await this.queue.getJob(jobId);
    return job ? job.getState() : 'missing';
  }

  logsWhere(predicate: (line: LogLine) => boolean): LogLine[] {
    return this.lines.filter(predicate);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.hosts.map((host) => host.stop('test cleanup')));
    await this.producer.close();
    await this.queue.obliterate({ force: true }).catch(() => undefined);
    await this.queue.close();
    this.connection.disconnect();
  }
}
