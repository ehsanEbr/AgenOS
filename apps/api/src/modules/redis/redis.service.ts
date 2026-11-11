import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import type { ApiConfig } from '@agentos/config';
import { APP_CONFIG } from '../config/config.module';

/** Owns the API's Redis connection (queue producer + health checks). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: IORedis;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    this.client = new IORedis(config.REDIS_URL, {
      // Fail commands quickly instead of queueing them forever when Redis is down.
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    // Connection errors are surfaced through health checks and job enqueue failures.
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
