import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type ApiConfig } from '../config';

const CONNECT_TIMEOUT_MS = 5000;

/**
 * The single Prisma Client for the API process (PostgreSQL is the source of truth, ADR-004).
 *
 * Lifecycle:
 * - Startup: tries to connect, but an unreachable database is NOT fatal. The API still starts, reports
 *   `not_ready` on /api/v1/health/ready, and Prisma reconnects lazily on the next query.
 * - Shutdown: disconnects (triggered by `app.enableShutdownHooks()` on SIGTERM/SIGINT).
 *
 * Only code inside the database module may import Prisma (enforced by ESLint). Other modules get
 * data through repositories exported by their own module, never through Prisma types.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    super({ datasourceUrl: config.DATABASE_URL });
  }

  async onModuleInit(): Promise<void> {
    try {
      await withTimeout(this.$connect(), CONNECT_TIMEOUT_MS, 'PostgreSQL connect');
      this.logger.log('Connected to PostgreSQL');
    } catch (err) {
      // Log the error class only: driver messages can contain connection details.
      this.logger.warn(
        `PostgreSQL is not reachable at startup (${err instanceof Error ? err.name : 'error'}); ` +
          'the API will report not_ready until it is.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (err) {
      // If the first connection never succeeded, Prisma re-throws that original failure here.
      // Shutdown must still complete, so log the error class and carry on.
      this.logger.warn(
        `Error while disconnecting from PostgreSQL (${err instanceof Error ? err.name : 'error'}); continuing shutdown`,
      );
    }
  }

  /** Cheapest possible round trip; used by the readiness probe. Rejects if PostgreSQL is unreachable. */
  async checkConnection(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
