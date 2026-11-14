import { readinessResponseSchema, systemPingJob } from '@agentos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, currentRevision, inspectImages } from '../src/stack';
import { waitFor } from '../src/wait';

/*
 * The complete local stack as a black box: web, api, worker, migrate, PostgreSQL and Redis, started with the same Compose file
 * and commands a developer uses. One throwaway project (own volumes, network and ports; see Stack).
 *
 * The tests run in order and share the stack: startup, behavior, then shutdown and persistence last.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await Stack.create();
  await stack.up(['api', 'worker', 'web']); // starts everything they depend on, and waits for health checks
});
afterAll(async () => {
  await stack.destroy();
});

describe('the stack runs on the verified images', () => {
  it('every container was created from the image that was built from this commit (not a developer image)', async () => {
    const revision = await currentRevision();
    const images = await inspectImages(); // agentos-*:systest, never the developer's agentos-*:local
    const byReference = new Map(images.map((image) => [image.reference, image]));
    const expected: Record<string, string> = {
      api: 'agentos-api:systest',
      migrate: 'agentos-api:systest',
      worker: 'agentos-worker:systest',
      web: 'agentos-web:systest',
    };
    for (const [service, reference] of Object.entries(expected)) {
      const image = byReference.get(reference);
      expect(image?.revision, `${reference} revision label`).toBe(revision);
      expect(await stack.containerImageId(service), `${service} container image`).toBe(image?.id);
    }
  });
});

describe('startup respects dependency readiness', () => {
  it('runs migrations to completion before the API starts, and every long-running service becomes healthy', async () => {
    const migrate = await stack.state('migrate');
    const api = await stack.state('api');
    expect(migrate).toMatchObject({ status: 'exited', exitCode: 0 }); // the one-shot succeeded
    expect(new Date(migrate.finishedAt).getTime()).toBeLessThanOrEqual(new Date(api.startedAt).getTime());

    for (const service of ['postgres', 'redis', 'api', 'worker', 'web']) {
      expect(await stack.state(service), service).toMatchObject({
        status: 'running',
        health: 'healthy',
        restartCount: 0,
      });
    }
  });

  it('keeps PostgreSQL and Redis off every interface except loopback', async () => {
    for (const service of ['postgres', 'redis', 'api', 'web']) {
      const inspect = await stack.compose([
        'port',
        service,
        service === 'postgres' ? '5432' : service === 'redis' ? '6379' : service === 'api' ? '3000' : '8080',
      ]);
      expect(inspect.stdout.trim(), service).toMatch(/^127\.0\.0\.1:\d+$/);
    }
    // The worker publishes nothing: it has no HTTP server.
    expect((await stack.compose(['ps', '--format', '{{.Ports}}', 'worker'])).stdout.trim()).toBe('');
  });
});

describe('the services work together', () => {
  it('serves the web app and forwards /api to the API through the same-origin proxy', async () => {
    const page = await fetch(stack.webUrl('/'));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');

    const viaWeb = await fetch(stack.webUrl('/api/v1/health/ready'));
    const direct = await fetch(stack.apiUrl('/api/v1/health/ready'));
    expect(viaWeb.status).toBe(200);
    expect(readinessResponseSchema.parse(await viaWeb.json())).toMatchObject({
      status: 'ready',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
    expect(direct.status).toBe(200);

    const unknown = await fetch(stack.webUrl('/api/v1/does-not-exist'));
    expect(unknown.status).toBe(404); // the API's own 404, not the web app's index.html
    expect(unknown.headers.get('content-type')).toContain('application/json');
  });

  it('a job submitted through the shared Redis is processed by the separate worker container', async () => {
    const { jobId, correlationId } = await stack
      .producer()
      .enqueue(systemPingJob, { message: 'system test' }, { correlationId: 'systest-corr-1' });
    expect(correlationId).toBe('systest-corr-1');
    await waitFor(async () => (await stack.jobState(jobId)) === 'completed', {
      message: 'worker to complete the ping',
      timeoutMs: 60_000,
    });

    const logs = await stack.logs('worker');
    const line = logs
      .split('\n')
      .map((l) => (l.startsWith('{') ? (JSON.parse(l) as Record<string, unknown>) : undefined))
      .find((l) => l?.msg === 'job completed' && l.jobId === jobId);
    expect(line).toMatchObject({
      queue: 'system',
      jobType: 'system.ping',
      correlationId: 'systest-corr-1',
      worker: stack.workerName,
    });
    expect(logs).not.toContain(stack.redisPassword); // credentials never reach the logs
  });

  it('the worker container holds no PostgreSQL credentials (it has no database access)', async () => {
    const environment = await stack.exec('worker', [
      'node',
      '-e',
      'console.log(Object.keys(process.env).sort().join(","))',
    ]);
    expect(environment.stdout).not.toContain('DATABASE_URL');
    expect(environment.stdout).toContain('REDIS_URL');
  });
});

describe('predictable shutdown, and data that survives it', () => {
  it('stops every service gracefully (exit code 0, never SIGKILLed) well inside the grace periods', async () => {
    // Data to look for after the restart: a Redis key and a PostgreSQL row.
    await stack.redis().set('systest:persist', 'kept');
    const created = await stack.exec('postgres', [
      'psql',
      '-U',
      'agentos',
      '-d',
      'agentos',
      '-tAc',
      "CREATE TABLE IF NOT EXISTS persist_check (v text); INSERT INTO persist_check VALUES ('kept');",
    ]);
    expect(created.code).toBe(0);

    const startedAt = Date.now();
    const stopped = await stack.compose(['stop', '--timeout', '45'], 180_000);
    const seconds = (Date.now() - startedAt) / 1000;
    expect(stopped.code).toBe(0);
    expect(seconds).toBeLessThan(45); // nobody needed to be killed at the grace deadline

    for (const service of ['web', 'api', 'worker', 'redis', 'postgres']) {
      const state = await stack.state(service);
      expect({ service, status: state.status, exitCode: state.exitCode, oomKilled: state.oomKilled }).toEqual(
        {
          service,
          status: 'exited',
          exitCode: 0, // 137 would mean SIGKILL: the service ignored the stop signal
          oomKilled: false,
        },
      );
    }
  });

  it('keeps the named volumes through `down` and finds the data again after the next `up`', async () => {
    const down = await stack.compose(['down', '--timeout', '20'], 180_000); // NOT --volumes
    expect(down.code).toBe(0);
    expect(await stack.volumeExists('postgres-data')).toBe(true);
    expect(await stack.volumeExists('redis-data')).toBe(true);

    await stack.up(['postgres', 'redis']);
    const row = await stack.exec('postgres', [
      'psql',
      '-U',
      'agentos',
      '-d',
      'agentos',
      '-tAc',
      'SELECT count(*) FROM persist_check',
    ]);
    expect(row.stdout.trim()).toBe('1');
    expect(
      await waitFor(() => stack.redis().get('systest:persist'), {
        message: 'Redis key to survive',
        timeoutMs: 30_000,
      }),
    ).toBe('kept');
  });
});
