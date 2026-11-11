import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildPinoHttpOptions } from './common/logging';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { APP_CONFIG, ConfigModule, type ApiConfig } from './modules/config';
import { HealthModule } from './modules/health';

@Module({
  imports: [
    ConfigModule,
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
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
