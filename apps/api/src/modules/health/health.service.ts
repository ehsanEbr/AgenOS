import { Injectable, Logger } from '@nestjs/common';
import type { DependencyCheck, ReadinessResponse } from '@agentos/contracts';
import { TimeoutError, withTimeout } from '../../common/with-timeout';
import { PrismaService } from '../database';
import { RedisService } from '../redis';

/** Upper bound for each dependency probe. Kept below typical orchestrator probe timeouts (3-5 s). */
export const READINESS_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Readiness = every REQUIRED dependency answers within the timeout. Probes run in parallel, so a slow
   * dependency cannot delay the other one's result.
   */
  async checkReadiness(): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([
      this.probe('postgres', () => this.prisma.checkConnection()),
      this.probe('redis', () => this.redis.checkConnection()),
    ]);
    const ready = postgres.status === 'up' && redis.status === 'up';
    return { status: ready ? 'ready' : 'not_ready', checks: { postgres, redis } };
  }

  private async probe(name: string, check: () => Promise<void>): Promise<DependencyCheck> {
    const started = performance.now();
    try {
      await withTimeout(check(), READINESS_TIMEOUT_MS, name);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      const reason = err instanceof TimeoutError ? 'timeout' : 'unavailable';
      // Server-side log carries the error class only; the response carries a fixed-vocabulary reason.
      this.logger.warn(
        `Readiness check failed for ${name}: ${reason} (${err instanceof Error ? err.name : 'error'})`,
      );
      return { status: 'down', reason };
    }
  }
}
