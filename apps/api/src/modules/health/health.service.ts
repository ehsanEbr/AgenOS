import { Injectable, Logger } from '@nestjs/common';
import type { DependencyCheck, ReadinessResponse } from '@agentos/contracts';
import { TimeoutError, withTimeout } from '../../common/with-timeout';
import { PrismaService } from '../database';
import { RedisService } from '../redis';

/** Upper bound for each dependency probe. Kept below typical orchestrator probe timeouts (3-5 s). */
export const READINESS_TIMEOUT_MS = 2000;

type DependencyName = keyof ReadinessResponse['checks'];

/**
 * Every infrastructure dependency the API knows about, and whether the API can serve traffic without it.
 * `required: true` => its failure makes the API `not_ready`. A dependency that is merely nice-to-have must be
 * declared `required: false`: it is still probed and reported, but it never flips readiness. Adding a dependency
 * means making this decision explicitly here (and in ADR-0004's table), never by default.
 */
export const DEPENDENCIES: Readonly<Record<DependencyName, { required: boolean }>> = {
  postgres: { required: true }, // source of truth (ADR-004)
  redis: { required: true }, // cache / ephemeral state; required since Phase 1.2 (ADR-0003)
};

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
    const checks = { postgres, redis };
    const ready = (Object.keys(DEPENDENCIES) as DependencyName[]).every(
      (name) => !DEPENDENCIES[name].required || checks[name].status === 'up',
    );
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  private async probe(name: DependencyName, check: () => Promise<void>): Promise<DependencyCheck> {
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
