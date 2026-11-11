import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiConfig } from '@agentos/config';
import { QUEUE_NAMES, apiErrorSchema, readinessResponseSchema, systemJobSchema } from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG } from '../src/modules/config/config.module';

describe('API (integration: PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let redis: IORedis;
  let queue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app, app.get<ApiConfig>(APP_CONFIG));
    await app.init();

    redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.SYSTEM_JOBS, { connection: redis });
  });

  afterAll(async () => {
    await queue?.close();
    redis?.disconnect();
    await app?.close();
  });

  it('GET /health/live', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports PostgreSQL and Redis as up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    const body = readinessResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('serves the OpenAPI document with the system job endpoints', async () => {
    const res = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health/live', '/api/v1/health/ready', '/api/v1/system/jobs']),
    );
  });

  it('echoes a supplied correlation id', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .set('x-correlation-id', 'test-correlation-1')
      .expect(200);
    expect(res.headers['x-correlation-id']).toBe('test-correlation-1');
  });

  it('rejects invalid job requests with the standard error format', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/jobs')
      .send({ message: '' })
      .expect(400);
    const body = apiErrorSchema.parse(res.body);
    expect(body.code).toBe('validation_error');
    expect(body.correlationId).toBeTruthy();
  });

  it('returns 404 in the standard format for unknown jobs', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/jobs/7c9e6679-7425-40de-944b-e07fc1f90ae7')
      .expect(404);
    expect(apiErrorSchema.parse(res.body).code).toBe('job_not_found');
  });

  it('persists a submitted job as QUEUED and enqueues it with a minimal payload', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/jobs')
      .set('x-correlation-id', 'int-test-job')
      .send({ message: 'integration' })
      .expect(202);
    const job = systemJobSchema.parse(created.body);
    expect(job.status).toBe('QUEUED');

    const fetched = await request(app.getHttpServer()).get(`/api/v1/system/jobs/${job.id}`).expect(200);
    expect(systemJobSchema.parse(fetched.body).id).toBe(job.id);

    const queued = await queue.getJob(job.id);
    expect(queued?.data).toEqual({ jobId: job.id, correlationId: 'int-test-job' });
    await queued?.remove();
  });
});
