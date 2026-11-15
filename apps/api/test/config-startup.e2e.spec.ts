import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/database';
import { RedisService } from '../src/modules/redis';
import { createInfrastructureStubs } from './support/create-test-app';

/*
 * The startup path: AppModule is built the way main.ts builds it, with the REAL configuration loader reading the process
 * environment (no APP_CONFIG override). Only the two infrastructure connections are replaced, so nothing here needs a database.
 * A ConfigError raised while the module graph is created is exactly what makes `main.ts` log it and exit with a non-zero code.
 */

function boot() {
  const stubs = createInfrastructureStubs();
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(stubs.postgres)
    .overrideProvider(RedisService)
    .useValue(stubs.redis)
    .compile();
}

describe('application startup and the insecure-origin allowance', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('REFUSES to start with NODE_ENV=production and AUTH_ALLOW_INSECURE_ORIGIN=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOW_INSECURE_ORIGIN', 'true');
    vi.stubEnv('WEB_ORIGIN', 'http://app.example.com');
    await expect(boot()).rejects.toThrow(
      /Invalid configuration[\s\S]*AUTH_ALLOW_INSECURE_ORIGIN[\s\S]*NODE_ENV=production/,
    );
  });

  it('refuses it whatever the origin is, because the flag itself is what must not exist in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOW_INSECURE_ORIGIN', 'true');
    vi.stubEnv('WEB_ORIGIN', 'https://app.example.com');
    await expect(boot()).rejects.toThrow(/AUTH_ALLOW_INSECURE_ORIGIN/);
  });

  it('starts in production with the flag off', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_ALLOW_INSECURE_ORIGIN', 'false');
    vi.stubEnv('WEB_ORIGIN', 'https://app.example.com');
    const module = await boot();
    await module.close();
  });

  it('still starts in development with the flag on (the intended development convenience)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_ALLOW_INSECURE_ORIGIN', 'true');
    vi.stubEnv('WEB_ORIGIN', 'http://app.example.com');
    const module = await boot();
    await module.close();
  });
});
