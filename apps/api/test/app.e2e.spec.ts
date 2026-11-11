import 'reflect-metadata';
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, healthResponseSchema } from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { createZodDto } from '../src/common/zod-validation.pipe';
import { APP_CONFIG, type ApiConfig } from '../src/modules/config';

// Phase 1.1 has no business endpoints; this test-only controller exercises the global
// validation pipeline and the error contract end to end.
class EchoDto extends createZodDto(z.object({ name: z.string().trim().min(1) })) {}

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

describe('API pipeline (e2e, in-process)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app, app.get<ApiConfig>(APP_CONFIG));
    await app.init();
  });

  afterAll(async () => {
    await app.close(); // exercises the shutdown path
  });

  it('GET /api/v1/health returns the contract shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.parse(res.body).service).toBe('api');
  });

  it('generates a correlation id and echoes a supplied one', async () => {
    const generated = await request(app.getHttpServer()).get('/api/v1/health');
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('x-correlation-id', 'my-id-1');
    expect(supplied.headers['x-correlation-id']).toBe('my-id-1');
  });

  it('serves the OpenAPI document generated from the contracts', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\.1/);
    expect(res.body.paths['/api/v1/health'].get.responses['200']).toBeDefined();
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
