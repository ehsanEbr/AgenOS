import { Injectable } from '@nestjs/common';
import type { DependencyCheck, ReadinessResponse } from '@agentos/contracts';
import { withTimeout } from '../../common/with-timeout';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
    ]);
    const allUp = database.status === 'up' && redis.status === 'up';
    return { status: allUp ? 'ok' : 'degraded', checks: { database, redis } };
  }

  private async probe(name: string, fn: () => PromiseLike<unknown>): Promise<DependencyCheck> {
    const started = performance.now();
    try {
      await withTimeout(Promise.resolve(fn()), CHECK_TIMEOUT_MS, name);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      // Only the failure class is exposed; connection strings/details stay in logs.
      return {
        status: 'down',
        error: err instanceof Error && /timed out/.test(err.message) ? 'timeout' : 'unreachable',
      };
    }
  }
}
