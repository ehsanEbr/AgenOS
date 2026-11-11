import type { Logger } from '@agentos/logger';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from './shutdown';

function setup(overrides: { drain?: () => Promise<void>; cleanup?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const exit = vi.fn();
  const shutdown = createShutdownHandler({
    drain: overrides.drain ?? (async () => void order.push('drain')),
    cleanup: overrides.cleanup ?? (async () => void order.push('cleanup')),
    logger,
    exit,
    timeoutMs: 50,
  });
  return { shutdown, exit, order };
}

describe('createShutdownHandler', () => {
  it('drains in-flight work before releasing connections, then exits 0', async () => {
    const { shutdown, exit, order } = setup();
    await shutdown('SIGTERM');
    expect(order).toEqual(['drain', 'cleanup']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('ignores repeated signals', async () => {
    const { shutdown, exit, order } = setup();
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(order).toEqual(['drain', 'cleanup']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when draining fails', async () => {
    const { shutdown, exit } = setup({ drain: () => Promise.reject(new Error('boom')) });
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 if a job never finishes', async () => {
    const { shutdown, exit } = setup({ drain: () => new Promise(() => undefined) });
    void shutdown('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
