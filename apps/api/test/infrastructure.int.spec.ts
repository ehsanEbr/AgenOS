import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readinessResponseSchema } from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG, type ApiConfig, loadApiConfig } from '../src/modules/config';
import { PrismaService } from '../src/modules/database';
import { RedisService } from '../src/modules/redis';

// Requires the Docker Compose stack: `pnpm setup:env && pnpm infra:up`.

/** Redis URL pointing at logical database 15 so test keys never mix with development data. */
function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/15';
  return parsed.toString();
}

async function createApp(overrides: Partial<Record<'DATABASE_URL' | 'REDIS_URL', string>> = {}) {
  const base = loadApiConfig();
  const config: ApiConfig = { ...base, REDIS_URL: isolatedRedisUrl(base.REDIS_URL), ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  configureApp(app, config);
  await app.init();
  return app;
}

describe('infrastructure (integration: real PostgreSQL + Redis)', () => {
  describe('with both services available', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    it('PrismaService reaches PostgreSQL', async () => {
      const prisma = app.get(PrismaService);
      await expect(prisma.checkConnection()).resolves.toBeUndefined();
      const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(rows[0]?.ok).toBe(1);
    });

    it('RedisService authenticates and round-trips a namespaced key, then cleans up', async () => {
      const redis = app.get(RedisService);
      const key = `it:${crypto.randomUUID()}`;
      await expect(redis.checkConnection()).resolves.toBeUndefined();
      await redis.client.set(key, 'value', 'EX', 30);
      expect(await redis.client.get(key)).toBe('value');
      await redis.client.del(key);
      expect(await redis.client.get(key)).toBeNull();
    });

    it('GET /api/v1/health/ready is 200 and ready', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      const body = readinessResponseSchema.parse(res.body);
      expect(body.status).toBe('ready');
      expect(body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('GET /api/v1/health stays live', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    });
  });

  describe('with an unreachable dependency', () => {
    it('reports not_ready (503) when Redis is unreachable, while PostgreSQL stays up', async () => {
      const app = await createApp({ REDIS_URL: 'redis://:wrong@127.0.0.1:1' });
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
        const body = readinessResponseSchema.parse(res.body);
        expect(body.status).toBe('not_ready');
        expect(body.checks.redis.status).toBe('down');
        expect(body.checks.postgres.status).toBe('up');
        expect(JSON.stringify(body)).not.toContain('wrong');
        await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      } finally {
        await app.close();
      }
    });

    it('reports not_ready (503) when PostgreSQL is unreachable, while Redis stays up', async () => {
      const app = await createApp({
        DATABASE_URL: 'postgresql://nobody:wrong@127.0.0.1:1/none?schema=public',
      });
      try {
        const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
        const body = readinessResponseSchema.parse(res.body);
        expect(body.status).toBe('not_ready');
        expect(body.checks.postgres.status).toBe('down');
        expect(body.checks.redis.status).toBe('up');
        expect(JSON.stringify(body)).not.toContain('wrong');
      } finally {
        await app.close();
      }
    });
  });

  it('closes both connections on shutdown', async () => {
    const app = await createApp();
    const redis = app.get(RedisService);
    expect(redis.client.status).toBe('ready');
    await app.close();
    expect(['end', 'close']).toContain(redis.client.status);
  });
});
