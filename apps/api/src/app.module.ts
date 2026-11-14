import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildPinoHttpOptions } from './common/logging';
import { RequestContextModule } from './common/request-context.module';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { APP_CONFIG, ConfigModule, type ApiConfig } from './modules/config';
import { DatabaseExceptionFilter } from './modules/database';
import { HealthModule } from './modules/health';

/**
 * Composition root: wires modules and registers the global (cross-cutting) pipe and filters.
 * Domain modules are added to `imports`; they never register global providers themselves.
 */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) => ({
        // Express 5 (Nest 11) requires named wildcards; the default '*' triggers a deprecation warning.
        forRoutes: ['{*splat}'],
        pinoHttp: buildPinoHttpOptions(config),
      }),
    }),
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // ORDER MATTERS: Nest gives later filters priority, so the catch-all comes first and
    // the specific filters after it.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DatabaseExceptionFilter },
  ],
})
export class AppModule {}
