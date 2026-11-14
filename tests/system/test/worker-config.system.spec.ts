import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';
import { waitFor } from '../src/wait';

/*
 * A worker that can never start because its configuration is invalid must be LOUD and must STOP: the exit code 2 and a message
 * naming the variable stay visible, and the restart policy gives up after its limit instead of looping forever.
 * (Docker's `on-failure` cannot exclude one exit code, so "gives up after 5 tries" is how a hopeless worker is bounded.)
 */

let stack: Stack;
beforeAll(async () => {
  stack = await Stack.create({ env: { WORKER_CONCURRENCY: '0' } }); // invalid: must be 1-100
});
afterAll(async () => {
  await stack.destroy();
});

describe('invalid worker configuration', () => {
  it('exits with code 2, is retried a bounded number of times, then stays down with a diagnosable log', async () => {
    await stack.up(['worker'], { wait: false });

    const final = await waitFor(
      async () => {
        const state = await stack.state('worker');
        return state.status === 'exited' && state.restartCount >= 5 ? state : undefined;
      },
      { message: 'the restart policy to give up', timeoutMs: 120_000 },
    );
    expect(final.exitCode).toBe(2); // the configuration error code, not a generic failure
    expect(final.restartCount).toBe(5); // exactly the policy's limit: no endless loop

    const logs = await stack.logs('worker');
    expect(logs).toContain('WORKER_CONCURRENCY'); // names the variable...
    expect(logs).not.toContain(stack.redisPassword); // ...and no credential
    expect(logs.split('\n').filter((l) => l.includes('WORKER_CONCURRENCY')).length).toBe(6); // 1 start + 5 restarts, all visible

    // Still exactly one container, and Docker reports it as stopped, not as a worker that merely looks unhealthy.
    expect(
      (await stack.compose(['ps', '-a', '-q', 'worker'])).stdout.trim().split(/\s+/).filter(Boolean),
    ).toHaveLength(1);
    expect(final.status).toBe('exited');
  });
});
