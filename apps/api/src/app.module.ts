import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { ApiConfig } from '@agentos/config';
import { buildLoggerOptions } from '@agentos/logger';
import { getCorrelationId } from './common/correlation-id.middleware';
import { ConfigModule, APP_CONFIG } from './modules/config/config.module';
import { DatabaseModule } from './modules/database/database.module';
import { HealthModule } from './modules/health/health.module';
import { RedisModule } from './modules/redis/redis.module';
import { SystemJobsModule } from './modules/system-jobs/system-jobs.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) => ({
        // Express 5 (Nest 11) requires named wildcards; the default '*' triggers a deprecation warning.
        forRoutes: ['{*splat}'],
        pinoHttp: {
          ...buildLoggerOptions({
            service: 'api',
            level: config.LOG_LEVEL,
            pretty: config.NODE_ENV === 'development',
          }),
          genReqId: (req) => getCorrelationId(req),
          customProps: (req) => ({ correlationId: getCorrelationId(req) }),
          // Probes are noisy; request logs for them add no value.
          autoLogging: { ignore: (req) => req.url?.includes('/health/') ?? false },
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    SystemJobsModule,
  ],
})
export class AppModule {}
