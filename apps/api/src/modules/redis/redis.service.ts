import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type ApiConfig } from '../config';

const CONNECT_TIMEOUT_MS = 3000;

/**
 * The API's Redis connection: cache, rate-limit counters and other ephemeral state only.
 * Redis is never the source of truth for business data (ADR-004).
 *
 * Like PostgreSQL, an unreachable Redis is not fatal at startup; readiness reports it and ioredis keeps
 * reconnecting in the background. Only code inside the redis module may import ioredis (enforced by ESLint).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private outage = false;
  private shutdown?: Promise<void>;
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      // Fail commands quickly instead of queueing them indefinitely while Redis is down.
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });

    // ioredis emits "error" for every failed attempt; log only the transitions to avoid flooding.
    this.client.on('error', (err: NodeJS.ErrnoException) => {
      if (this.outage) return;
      this.outage = true;
      this.logger.warn(`Redis connection problem (${err.code ?? err.name}); retrying in the background`);
    });
    this.client.on('ready', () => {
      if (this.outage) this.logger.log('Redis connection recovered');
      this.outage = false;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await withTimeout(this.client.connect(), CONNECT_TIMEOUT_MS, 'Redis connect');
      this.logger.log('Connected to Redis');
    } catch (err) {
      this.logger.warn(
        `Redis is not reachable at startup (${err instanceof Error ? err.name : 'error'}); ` +
          'the API will report not_ready until it is.',
      );
    }
  }

  /** Closes the connection exactly once; repeated calls (hook + manual close) share the same promise. */
  onModuleDestroy(): Promise<void> {
    this.shutdown ??= this.closeConnection();
    return this.shutdown;
  }

  private async closeConnection(): Promise<void> {
    if (this.client.status === 'ready') {
      try {
        await this.client.quit(); // graceful: lets pending replies finish
        return;
      } catch {
        // fall through to a hard close
      }
    }
    this.client.disconnect();
  }

  /** Round trip used by the readiness probe. Rejects if Redis is unreachable or answers unexpectedly. */
  async checkConnection(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error('Unexpected reply to PING');
  }
}
