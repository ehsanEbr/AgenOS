import { Redis } from 'ioredis';

/**
 * Who is using the connection decides how it must behave when Redis is slow or down:
 *
 *  - `producer`  (API, schedulers): FAIL FAST. A request that wants to enqueue must not hang for minutes, so commands
 *                give up after a couple of retries and the caller can answer 503.
 *  - `worker`    (job consumers): WAIT. BullMQ requires `maxRetriesPerRequest: null` for workers: blocking commands
 *                are retried until Redis comes back, which is exactly what makes a worker recover from an outage.
 *
 * Both reconnect forever with a capped delay; only the behavior of individual COMMANDS differs.
 */
export type RedisRole = 'producer' | 'worker';

export interface RedisConnectionOptions {
  role: RedisRole;
  /** Shown in `CLIENT LIST` on the Redis server, so operators can tell who is connected. */
  name: string;
  /** Connection-level errors (ECONNREFUSED, auth failures). Without a listener ioredis prints them to the console. */
  onError?: (error: Error) => void;
}

/** Delay between reconnect attempts: 200 ms, 400 ms, ... capped at 5 s. Never gives up. */
export const reconnectDelay = (attempt: number): number => Math.min(attempt * 200, 5_000);

export function createRedisConnection(url: string, { role, name, onError }: RedisConnectionOptions): Redis {
  const connection = new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: role === 'worker' ? null : 2,
    retryStrategy: reconnectDelay,
    connectTimeout: 10_000,
  });
  connection.on('error', (error) => onError?.(error));
  return connection;
}

export type { Redis } from 'ioredis';
