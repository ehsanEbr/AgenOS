import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@agentos/database';
import type { ApiConfig } from '@agentos/config';
import { APP_CONFIG } from '../config/config.module';

/**
 * Shared Prisma client. Connects lazily so the API can start (and report `degraded`
 * from /health/ready) while PostgreSQL is still unavailable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    super({ datasourceUrl: config.DATABASE_URL });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
