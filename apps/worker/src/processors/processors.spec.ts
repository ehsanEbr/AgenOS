import { QUEUE_NAMES, systemPingJob } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import { describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../runtime';
import { createRegistry } from './index';
import { systemPingProcessor } from './system-ping';

const context = (signal: AbortSignal = new AbortController().signal) => {
  const info = vi.fn();
  const ctx = { logger: { info } as unknown as Logger, signal } as unknown as JobContext;
  return { ctx, info };
};

describe('system.ping', () => {
  it('handles a job with no delay immediately and logs it', async () => {
    const { ctx, info } = context();
    await systemPingProcessor.handle({ delayMs: 0 }, ctx);
    expect(info).toHaveBeenCalledWith({ delayMs: 0 }, 'system.ping handled');
  });

  it('simulates work for delayMs, and stops early when the job is aborted', async () => {
    const controller = new AbortController();
    const { ctx, info } = context(controller.signal);
    const running = systemPingProcessor.handle({ delayMs: 60_000 }, ctx);
    controller.abort(new Error('timeout'));
    await expect(running).rejects.toThrow('timeout');
    expect(info).not.toHaveBeenCalled(); // it did not pretend to have finished
  });

  it('is idempotent by nature: running it twice has no accumulated effect', async () => {
    const { ctx } = context();
    await systemPingProcessor.handle({ delayMs: 0 }, ctx);
    await expect(systemPingProcessor.handle({ delayMs: 0 }, ctx)).resolves.toBeUndefined();
  });
});

describe('createRegistry', () => {
  it('registers exactly the diagnostic processor today (no domain processors yet)', () => {
    const registry = createRegistry();
    expect(registry.size()).toBe(1);
    expect(registry.queues()).toEqual([QUEUE_NAMES.system]);
    expect(registry.find('system', systemPingJob.type, systemPingJob.version)).toMatchObject({ found: true });
  });
});
