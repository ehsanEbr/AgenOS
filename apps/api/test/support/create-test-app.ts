import 'reflect-metadata';
import type { INestApplication, Provider, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { APP_CONFIG, type ApiConfig } from '../../src/modules/config';
import { PrismaService } from '../../src/modules/database';
import { RedisService } from '../../src/modules/redis';

/**
 * Infrastructure stand-ins for in-process API tests. They replace the real PostgreSQL/Redis services so that
 * a test of the HTTP pipeline can never depend on (or be broken by) real infrastructure. Behavior against the real
 * services belongs in *.int.spec.ts.
 */
export interface InfrastructureStubs {
  postgres: { checkConnection: ReturnType<typeof vi.fn<() => Promise<void>>> };
  redis: { checkConnection: ReturnType<typeof vi.fn<() => Promise<void>>> };
}

export function createInfrastructureStubs(): InfrastructureStubs {
  return {
    postgres: { checkConnection: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
    redis: { checkConnection: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
  };
}

export interface TestAppOptions {
  /** Test-only controllers to mount next to the real application (they get the full global pipeline). */
  controllers?: Type[];
  /** Test-only providers (for example a stub application service). */
  providers?: Provider[];
  stubs?: InfrastructureStubs;
}

/**
 * Boots the real AppModule (global pipe, filters, logging, request context, OpenAPI) with stubbed infrastructure and
 * optional test-only controllers. This is the standard way to write controller/API tests.
 */
export async function createTestApp(options: TestAppOptions = {}) {
  const stubs = options.stubs ?? createInfrastructureStubs();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(PrismaService)
    .useValue(stubs.postgres)
    .overrideProvider(RedisService)
    .useValue(stubs.redis)
    .compile();

  const app: INestApplication = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app, app.get<ApiConfig>(APP_CONFIG));
  await app.init();
  return { app, stubs };
}
