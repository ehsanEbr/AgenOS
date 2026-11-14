import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type ApiConfig } from '../config';

const CONNECT_TIMEOUT_MS = 5000;

/**
 * The single Prisma Client for the API process (PostgreSQL is the source of truth, ADR-004). It owns the connection
 * lifecycle; nothing else connects or disconnects.
 *
 * Lifecycle:
 * - Startup: tries to connect, but an unreachable database is NOT fatal. The API still starts, reports
 *   `not_ready` on /api/v1/health/ready, and Prisma reconnects lazily on the next query.
 * - Shutdown: disconnects exactly once (triggered by `app.close()`, which main.ts calls on SIGTERM/SIGINT).
 *   Repeated calls return the same promise, and a failing disconnect is logged, never thrown.
 *
 * Who may inject it: repositories (infrastructure layer) and this module. Application services and controllers use
 * `TransactionRunner` and repositories instead (enforced by ESLint).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private shutdown?: Promise<void>;

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

  onModuleDestroy(): Promise<void> {
    this.shutdown ??= this.disconnectSafely();
    return this.shutdown;
  }

  private async disconnectSafely(): Promise<void> {
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
