import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildPinoHttpOptions } from './common/logging';
import { RequestContextModule } from './common/request-context.module';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { APP_CONFIG, ConfigModule, type ApiConfig } from './modules/config';
import { DatabaseExceptionFilter } from './modules/database';
import { HealthModule } from './modules/health';
import { AuthenticationGuard, IdentityModule } from './modules/identity';
import { OrganizationsModule } from './modules/organizations';
import { ProjectsModule } from './modules/projects';

/**
 * Composition root: wires modules and registers the global (cross-cutting) pipe, filters and guard.
 * Domain modules are added to `imports`; they never register global providers themselves.
 * The authentication guard is global so that every route is authenticated BY DEFAULT: a route nobody annotated is protected, and
 * leaving one open takes an explicit `@Public()` (ADR-0010).
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
    IdentityModule,
    OrganizationsModule,
    ProjectsModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    // ORDER MATTERS: Nest gives later filters priority, so the catch-all comes first and
    // the specific filters after it.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DatabaseExceptionFilter },
  ],
})
export class AppModule {}
