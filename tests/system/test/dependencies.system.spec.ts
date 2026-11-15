import { type ReadinessResponse, readinessResponseSchema } from '@agentos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';
import { httpStatus, waitFor } from '../src/wait';

/*
 * The API container against real PostgreSQL and Redis containers that come and go. Verifies the documented readiness
 * semantics from OUTSIDE the process: liveness never depends on infrastructure (so an outage never gets a healthy API killed),
 * readiness does, and the API recovers by itself without being restarted.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await Stack.create();
});
afterAll(async () => {
  await stack.destroy();
});

async function readiness(): Promise<{ http: number; body?: ReadinessResponse }> {
  try {
    const response = await fetch(stack.apiUrl('/api/v1/health/ready'), {
      signal: AbortSignal.timeout(8_000),
    });
    const parsed = readinessResponseSchema.safeParse(await response.json());
    return parsed.success ? { http: response.status, body: parsed.data } : { http: response.status };
  } catch {
    return { http: 0 };
  }
}
const liveness = () => httpStatus(stack.apiUrl('/api/v1/health'));

describe('the API starts without its dependencies and becomes ready when they appear', () => {
  it('starts with PostgreSQL and Redis absent: alive, but not ready, and it leaks nothing about the infrastructure', async () => {
    await stack.up(['api'], { wait: false, noDeps: true }); // deliberately NOT starting postgres/redis/migrate
    await waitFor(async () => (await liveness()) === 200, { message: 'API liveness', timeoutMs: 90_000 });

    const { http, body } = await waitFor(
      async () => {
        const result = await readiness();
        return result.http === 503 && result.body ? result : undefined;
      },
      { message: 'API readiness to answer 503 with its contract body' },
    );
    expect(http).toBe(503);
    expect(body).toMatchObject({
      status: 'not_ready',
      checks: { postgres: { status: 'down' }, redis: { status: 'down' } },
    });
    const response = await fetch(stack.apiUrl('/api/v1/health/ready'));
    expect(await response.text()).not.toMatch(
      /postgres:5432|redis:6379|password|ECONN|ENOTFOUND|getaddrinfo|@/i,
    );
  });

  it('becomes ready by itself when its dependencies start, without being restarted', async () => {
    const before = await stack.state('api');
    // postgres, redis and the role provisioning the API's database login depends on; waits for their health checks
    await stack.up(['postgres', 'redis', 'db-roles']);

    await waitFor(async () => (await readiness()).http === 200, {
      message: 'API readiness 200 after dependencies came up',
      timeoutMs: 90_000,
    });
    const after = await stack.state('api');
    expect(after.restartCount).toBe(0);
    expect(after.startedAt).toBe(before.startedAt); // the very same process: recovery needed no restart
  });
});

describe.each(['postgres', 'redis'] as const)('losing and regaining %s', (dependency) => {
  const other = dependency === 'postgres' ? 'redis' : 'postgres';

  it('turns readiness unhealthy (503) while liveness stays healthy, and names only the dependency that is down', async () => {
    expect((await readiness()).http).toBe(200);
    const stopped = await stack.compose(['stop', '--timeout', '20', dependency]);
    expect(stopped.code).toBe(0);

    const { body } = await waitFor(
      async () => {
        const result = await readiness();
        return result.http === 503 && result.body?.checks[dependency].status === 'down' ? result : undefined;
      },
      { message: `readiness to report ${dependency} down`, timeoutMs: 60_000 },
    );
    expect(body?.checks[other].status).toBe('up'); // the other dependency is unaffected
    expect(await liveness()).toBe(200); // an infrastructure outage must never make a healthy process look dead
  });

  it('recovers when the dependency returns, with no API restart', async () => {
    const before = await stack.state('api');
    const started = await stack.compose(['start', dependency]);
    expect(started.code).toBe(0);

    await waitFor(async () => (await readiness()).http === 200, {
      message: `readiness 200 after ${dependency} returned`,
      timeoutMs: 90_000,
    });
    const after = await stack.state('api');
    expect(after.restartCount).toBe(0);
    expect(after.startedAt).toBe(before.startedAt);
  });
});
