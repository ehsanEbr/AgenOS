import { systemPingJob } from '@agentos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';
import { staysTrue, waitFor } from '../src/wait';

/*
 * The worker as a SUPERVISED CONTAINER (restart policy `on-failure:5`, health check from the heartbeat file) against a real
 * Redis container. Only redis and worker run: the worker has no other dependency, which is itself part of what is verified.
 *
 * Docker's restart policy is not an application health check. It restarts a container whose process EXITED with a non-zero
 * code; it does not notice a hung or Redis-less worker, and it NEVER restarts a container that was stopped through the Docker
 * API (`docker stop`, `docker kill`: a "manual stop"). So tests that need a restart (or must prove there is none) signal the
 * worker process from inside the container, and the stop tests use `docker compose stop` only where a manual stop is the point.
 */

let stack: Stack;
beforeAll(async () => {
  stack = await Stack.create();
  await stack.up(['worker']); // redis (healthy) -> worker (healthy)
});
afterAll(async () => {
  await stack.destroy();
});

const ping = (delayMs: number) => stack.producer().enqueue(systemPingJob, { delayMs });
const completed = (jobId: string, timeoutMs = 90_000) =>
  waitFor(async () => (await stack.jobState(jobId)) === 'completed', {
    message: `job ${jobId} to complete`,
    timeoutMs,
  });
const probe = async () => stack.exec('worker', ['node', '/app/apps/worker/dist/healthcheck.js']);
const workerContainers = async () =>
  (await stack.compose(['ps', '-a', '-q', 'worker'])).stdout.trim().split(/\s+/).filter(Boolean);
const startsLogged = async () =>
  (await stack.logs('worker')).split('\n').filter((l) => l.includes('"msg":"worker starting"')).length;

describe('a healthy supervised worker', () => {
  it('processes a real job, reports healthy, and has exactly one connection to Redis', async () => {
    const { jobId } = await ping(0);
    await completed(jobId);

    expect(await stack.state('worker')).toMatchObject({
      status: 'running',
      health: 'healthy',
      restartCount: 0,
    });
    expect(await probe()).toMatchObject({ code: 0, stdout: expect.stringContaining('healthy: ready') });
    expect(await stack.workerConnections()).toHaveLength(1);
    expect(await workerContainers()).toHaveLength(1);
  });
});

describe('Redis outage and recovery', () => {
  it('is reported not ready while Redis is down, recovers by itself in the SAME process, and never duplicates the worker', async () => {
    const before = await stack.state('worker');

    expect((await stack.compose(['stop', '--timeout', '20', 'redis'])).code).toBe(0);
    const unready = await waitFor(
      async () => {
        const result = await probe();
        return result.code === 1 ? result : undefined;
      },
      { message: 'the health probe to report the worker not ready', timeoutMs: 60_000 },
    );
    expect(unready.stdout).toMatch(/not ready .*redis=/); // alive, but cut off from Redis: not ready
    expect((await stack.state('worker')).status).toBe('running'); // the process itself did not die or exit

    expect((await stack.compose(['start', 'redis'])).code).toBe(0);
    await waitFor(async () => (await probe()).code === 0, {
      message: 'the worker to become ready again',
      timeoutMs: 90_000,
    });

    const { jobId } = await ping(0);
    await completed(jobId); // and it works again

    const after = await stack.state('worker');
    expect(after.startedAt).toBe(before.startedAt); // same process: recovery needed no restart
    expect(after.restartCount).toBe(before.restartCount);
    expect(await stack.workerConnections()).toHaveLength(1); // not a second worker, not a leaked connection
    expect(await workerContainers()).toHaveLength(1);
  });
});

describe('unexpected exit: the supervisor restarts the worker', () => {
  it('restarts after SIGKILL, recovers the job that was running, and keeps a single worker', async () => {
    const before = await stack.state('worker');
    const startsBefore = await startsLogged();
    const { jobId } = await ping(6_000);
    await waitFor(async () => (await stack.jobState(jobId)) === 'active', {
      message: 'the job to become active',
    });

    await stack.signalWorkerProcess('SIGKILL'); // a crash: the process dies with no chance to clean up (container exit code 137)
    await waitFor(
      async () => {
        const state = await stack.state('worker');
        return state.restartCount === before.restartCount + 1 &&
          state.status === 'running' &&
          state.health === 'healthy'
          ? state
          : undefined;
      },
      { message: 'Docker to restart the worker and it to become healthy', timeoutMs: 90_000 },
    );

    await completed(jobId); // the unfinished job was not lost: redelivered after its lock expired
    expect(await startsLogged()).toBe(startsBefore + 1); // one new process, not two
    expect(await workerContainers()).toHaveLength(1);
    expect(await stack.workerConnections()).toHaveLength(1);
  });
});

describe('intentional shutdown', () => {
  it('exits 0 after finishing its active job, and Docker does NOT restart it', async () => {
    const before = await stack.state('worker');
    const { jobId } = await ping(4_000);
    await waitFor(async () => (await stack.jobState(jobId)) === 'active', {
      message: 'the job to become active',
    });

    await stack.signalWorkerProcess('SIGTERM'); // delivered to the worker process itself, like an orchestrator's terminate signal
    const exited = await waitFor(
      async () => {
        const state = await stack.state('worker');
        return state.status === 'exited' ? state : undefined;
      },
      { message: 'the worker to exit', timeoutMs: 60_000 },
    );
    expect(exited.exitCode).toBe(0); // clean shutdown: a non-zero code would be restarted by `on-failure`
    expect(await stack.jobState(jobId)).toBe('completed'); // the in-flight job was finished, not dropped

    // `on-failure` leaves a container that exited 0 alone. A restart would show within a second or two; wait well beyond it.
    await staysTrue(
      async () => (await stack.state('worker')).status === 'exited',
      6_000,
      'a cleanly stopped worker stays stopped',
    );
    expect((await stack.state('worker')).restartCount).toBe(before.restartCount);
  });

  it('a stop that outlives the grace period (SIGKILL) leaves the unfinished job unacknowledged, and it is recovered after the next start', async () => {
    await stack.up(['worker']);
    const { jobId } = await ping(12_000);
    await waitFor(async () => (await stack.jobState(jobId)) === 'active', {
      message: 'the job to become active',
    });

    // Docker sends SIGTERM, the worker starts draining (20 s grace configured), and 1 s later Docker kills it.
    expect((await stack.compose(['stop', '--timeout', '1', 'worker'])).code).toBe(0);
    expect(await stack.state('worker')).toMatchObject({ status: 'exited', exitCode: 137 });
    expect(await stack.jobState(jobId)).toBe('active'); // neither completed nor failed: nothing was acknowledged for it

    await stack.up(['worker']);
    await completed(jobId); // redelivered to the restarted worker and run to the end
  });
});
