import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Post } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema, readinessResponseSchema } from '@agentos/contracts';
import { createZodDto } from '../src/common/zod-validation.pipe';
import { type InfrastructureStubs, createTestApp } from './support/create-test-app';
import { Public } from '../src/modules/identity';

// Phase 1.x has no business endpoints; this test-only controller exercises the global
// validation pipeline and the error contract end to end.
class EchoDto extends createZodDto(z.object({ name: z.string().trim().min(1) })) {}

// A test fixture for the HTTP pipeline, not for authentication: public on purpose (default-deny is tested in identity.e2e.spec.ts).
@Public()
@Controller('test-echo')
class EchoController {
  @Post()
  echo(@Body() body: EchoDto) {
    return { hello: body.name };
  }

  @Post('boom')
  boom(): never {
    throw new Error('sensitive internal detail');
  }
}

describe('API pipeline (e2e, in-process, stubbed infrastructure)', () => {
  let app: INestApplication;
  let stubs: InfrastructureStubs;

  beforeAll(async () => {
    ({ app, stubs } = await createTestApp({ controllers: [EchoController] }));
  });

  beforeEach(() => {
    stubs.postgres.checkConnection.mockReset().mockResolvedValue(undefined);
    stubs.redis.checkConnection.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close(); // exercises the shutdown path
  });

  describe('liveness', () => {
    it('GET /api/v1/health returns the contract shape', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(healthResponseSchema.parse(res.body).service).toBe('api');
    });

    it('stays 200 when infrastructure is down (a dependency outage must not restart the process)', async () => {
      stubs.postgres.checkConnection.mockRejectedValue(new Error('down'));
      stubs.redis.checkConnection.mockRejectedValue(new Error('down'));
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(stubs.postgres.checkConnection).not.toHaveBeenCalled();
      expect(stubs.redis.checkConnection).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('GET /api/v1/health/ready is 200 when PostgreSQL and Redis are up', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(readinessResponseSchema.parse(res.body).status).toBe('ready');
    });

    it('is 503 with the same contract when PostgreSQL is down', async () => {
      stubs.postgres.checkConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      const body = readinessResponseSchema.parse(res.body);
      expect(body.status).toBe('not_ready');
      expect(body.checks.postgres).toEqual({ status: 'down', reason: 'unavailable' });
      expect(body.checks.redis.status).toBe('up');
    });

    it('is 503 when Redis is down', async () => {
      stubs.redis.checkConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      expect(readinessResponseSchema.parse(res.body).checks.redis.status).toBe('down');
    });

    it('does not leak infrastructure details and keeps the correlation id', async () => {
      stubs.postgres.checkConnection.mockRejectedValue(
        new Error('auth failed for postgresql://u:hunter2@db.internal/app'),
      );
      const res = await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .set('x-correlation-id', 'ready-check-1')
        .expect(503);
      expect(res.headers['x-correlation-id']).toBe('ready-check-1');
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|db\.internal|postgresql:\/\//);
    });
  });

  describe('pipeline (unchanged since Phase 1.1)', () => {
    it('generates a correlation id and echoes a supplied one', async () => {
      const generated = await request(app.getHttpServer()).get('/api/v1/health');
      expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);

      const supplied = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('x-correlation-id', 'my-id-1');
      expect(supplied.headers['x-correlation-id']).toBe('my-id-1');
    });

    it('serves the OpenAPI document with both health routes', async () => {
      const res = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
      expect(res.body.openapi).toMatch(/^3\.1/);
      expect(res.body.paths['/api/v1/health'].get.responses['200']).toBeDefined();
      expect(res.body.paths['/api/v1/health/ready'].get.responses['503']).toBeDefined();
    });

    it('serves Swagger UI', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(200);
    });

    it('validates DTOs globally and returns the standard error', async () => {
      const bad = await request(app.getHttpServer()).post('/api/v1/test-echo').send({ name: '' }).expect(400);
      const body = apiErrorSchema.parse(bad.body);
      expect(body.code).toBe('validation_error');
      expect(body.correlationId).toBe(bad.headers['x-correlation-id']);

      const ok = await request(app.getHttpServer())
        .post('/api/v1/test-echo')
        .send({ name: ' Ada ' })
        .expect(201);
      expect(ok.body).toEqual({ hello: 'Ada' });
    });

    it('hides internals of unexpected errors', async () => {
      const res = await request(app.getHttpServer()).post('/api/v1/test-echo/boom').expect(500);
      expect(apiErrorSchema.parse(res.body)).toMatchObject({
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(JSON.stringify(res.body)).not.toContain('sensitive');
    });

    it('returns the standard error for unknown routes', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      expect(apiErrorSchema.parse(res.body).code).toBe('not_found');
    });
  });
});
