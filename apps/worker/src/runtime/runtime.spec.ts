import { defineJob, systemPingJob } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IllegalTransitionError, type HostState, Lifecycle } from './lifecycle';
import { PermanentJobError, abortableDelay, defineProcessor } from './processor';
import { ProcessorRegistry } from './registry';
import { WorkerHost } from './host';
import { settlesWithin, withTimeout } from './util';

const noopProcessor = (type: string, version = 1, queue: 'system' = 'system') =>
  defineProcessor(defineJob({ queue, type, version, payload: z.object({}) }), () => undefined);

describe('ProcessorRegistry', () => {
  it('finds a processor by queue, type and version', () => {
    const processor = noopProcessor('test.a');
    const registry = new ProcessorRegistry().register(processor);
    expect(registry.find('system', 'test.a', 1)).toEqual({ found: true, processor });
  });

  it('distinguishes an unknown type from an unsupported version', () => {
    const registry = new ProcessorRegistry()
      .register(noopProcessor('test.a', 1))
      .register(noopProcessor('test.a', 3));
    expect(registry.find('system', 'test.zzz', 1)).toMatchObject({ found: false, reason: 'unknown_type' });
    expect(registry.find('system', 'test.a', 2)).toMatchObject({
      found: false,
      reason: 'unsupported_version',
      supportedVersions: [1, 3],
    });
  });

  it('refuses to register the same (queue, type, version) twice: a mistake cannot silently replace a handler', () => {
    const registry = new ProcessorRegistry().register(noopProcessor('test.a'));
    expect(() => registry.register(noopProcessor('test.a'))).toThrow(/already registered/);
    expect(() => registry.register(noopProcessor('test.a', 2))).not.toThrow(); // different version is fine
  });

  it('does not match across queues', () => {
    const registry = new ProcessorRegistry().register(noopProcessor('test.a'));
    expect(registry.find('another-queue', 'test.a', 1)).toMatchObject({ found: false });
  });

  it('lists the queues it can serve and counts processors', () => {
    const registry = new ProcessorRegistry()
      .register(noopProcessor('test.a'))
      .register(noopProcessor('test.b'));
    expect(registry.queues()).toEqual(['system']);
    expect(registry.size()).toBe(2);
    expect(new ProcessorRegistry().queues()).toEqual([]);
  });
});

describe('Lifecycle state machine', () => {
  const walk = (...states: HostState[]) => {
    const lifecycle = new Lifecycle();
    states.forEach((state) => lifecycle.transition(state));
    return lifecycle;
  };

  it('starts as created', () => {
    expect(new Lifecycle().state).toBe('created');
  });

  it.each([
    [['starting', 'running', 'draining', 'stopped'], 'the normal life'],
    [['starting', 'failed', 'stopped'], 'a failed startup that is cleaned up'],
    [['starting', 'draining', 'stopped'], 'a stop requested during startup'],
    [['stopped'], 'stopping something that never started'],
  ] as [HostState[], string][])('allows %j (%s)', (states) => {
    expect(walk(...states).state).toBe(states.at(-1));
  });

  it.each([
    ['running', ['running']],
    ['starting', ['starting', 'starting']],
    ['created -> running (skipping startup)', ['running']],
    [
      'stopped -> starting (a host cannot restart)',
      ['starting', 'running', 'draining', 'stopped', 'starting'],
    ],
    ['draining -> running (shutdown cannot be undone)', ['starting', 'running', 'draining', 'running']],
    ['stopped -> anything', ['stopped', 'draining']],
  ] as [string, HostState[]][])('rejects %s', (_name, states) => {
    expect(() => walk(...states)).toThrow(IllegalTransitionError);
  });

  it('notifies listeners with the new and previous state, and stops after unsubscribe', () => {
    const lifecycle = new Lifecycle();
    const listener = vi.fn();
    const unsubscribe = lifecycle.onChange(listener);
    lifecycle.transition('starting');
    expect(listener).toHaveBeenCalledWith('starting', 'created');
    unsubscribe();
    lifecycle.transition('running');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('does not change state when a transition is rejected', () => {
    const lifecycle = new Lifecycle();
    expect(() => lifecycle.transition('running')).toThrow();
    expect(lifecycle.state).toBe('created');
  });
});

describe('processor helpers', () => {
  it('PermanentJobError is recognizable and keeps its cause', () => {
    const cause = new Error('root');
    const error = new PermanentJobError('no retry', { cause });
    expect(error.name).toBe('PermanentJobError');
    expect(error.cause).toBe(cause);
  });

  it('abortableDelay resolves after the delay', async () => {
    await expect(abortableDelay(10, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('abortableDelay rejects as soon as the signal aborts, and immediately if already aborted', async () => {
    const controller = new AbortController();
    const waiting = abortableDelay(60_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    await expect(abortableDelay(10, controller.signal)).rejects.toThrow('stop');
  });
});

describe('async helpers', () => {
  it('withTimeout passes the result through or times out', async () => {
    await expect(withTimeout(Promise.resolve(1), 100, 'x')).resolves.toBe(1);
    await expect(withTimeout(new Promise(() => undefined), 10, 'slow thing')).rejects.toThrow(
      'slow thing timed out after 10 ms',
    );
  });

  it('settlesWithin reports whether something finished in time and never rejects', async () => {
    expect(await settlesWithin(Promise.resolve(), 100)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error('x')), 100)).toBe(true);
    expect(await settlesWithin(new Promise(() => undefined), 10)).toBe(false);
  });
});

describe('WorkerHost construction', () => {
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const options = (queues: 'system'[], registry: ProcessorRegistry) => ({
    name: 'w',
    redisUrl: 'redis://127.0.0.1:1',
    prefix: 'p',
    queues,
    registry,
    logger,
    concurrency: 1,
    jobTimeoutMs: 1_000,
    shutdownGraceMs: 100,
    lockDurationMs: 1_000,
    startupTimeoutMs: 1_000,
  });

  it('refuses to consume a queue that has no processor (it would fail every job)', () => {
    expect(() => new WorkerHost(options(['system'], new ProcessorRegistry()))).toThrow(
      /No processor is registered for queue/,
    );
  });

  it('refuses an empty queue list', () => {
    expect(
      () => new WorkerHost(options([], new ProcessorRegistry().register(noopProcessor('test.a')))),
    ).toThrow(/at least one queue/);
  });

  it('is created but not ready, and never reports ready before start', () => {
    const host = new WorkerHost(
      options(['system'], new ProcessorRegistry().register(defineProcessor(systemPingJob, () => undefined))),
    );
    expect(host.state).toBe('created');
    expect(host.isReady).toBe(false);
    expect(host.status()).toEqual({ state: 'created', ready: false, redis: 'none', activeJobs: 0 });
  });

  it('stopping a host that never started is a clean no-op, and idempotent', async () => {
    const host = new WorkerHost(
      options(['system'], new ProcessorRegistry().register(noopProcessor('test.a'))),
    );
    const first = await host.stop('test');
    const second = await host.stop('test');
    expect(first).toEqual({ forced: false, abandonedJobs: 0, durationMs: 0 });
    expect(second).toEqual(first);
    expect(host.state).toBe('stopped');
  });
});
