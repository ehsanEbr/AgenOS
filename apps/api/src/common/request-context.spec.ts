import { describe, expect, it } from 'vitest';
import { currentCorrelationId, getRequestContext, runWithRequestContext } from './request-context';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('request context (AsyncLocalStorage)', () => {
  it('has no context outside a request', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('is available synchronously and across awaits, timers and promise combinators', async () => {
    await runWithRequestContext({ correlationId: 'req-1' }, async () => {
      expect(currentCorrelationId()).toBe('req-1');
      await sleep(5);
      expect(currentCorrelationId()).toBe('req-1');
      await Promise.all([
        sleep(1).then(() => currentCorrelationId()),
        Promise.resolve(currentCorrelationId()),
      ]).then((ids) => expect(ids).toEqual(['req-1', 'req-1']));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(currentCorrelationId()).toBe('req-1');
    });
  });

  it('isolates concurrent requests from each other', async () => {
    const seen = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        runWithRequestContext({ correlationId: `req-${i}` }, async () => {
          await sleep(Math.random() * 10);
          const afterDelay = currentCorrelationId();
          await sleep(Math.random() * 10);
          return [afterDelay, currentCorrelationId()];
        }),
      ),
    );
    seen.forEach(([first, second], i) => {
      expect(first).toBe(`req-${i}`);
      expect(second).toBe(`req-${i}`);
    });
  });

  it('does not leak after the request finishes', async () => {
    await runWithRequestContext({ correlationId: 'req-x' }, async () => sleep(1));
    expect(currentCorrelationId()).toBeUndefined();
  });
});
