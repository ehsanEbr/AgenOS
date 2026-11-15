import { afterEach, describe, expect, it, vi } from 'vitest';
import { Semaphore } from './semaphore';

const tooSlow = () => new Error('no slot in time');

describe('Semaphore', () => {
  afterEach(() => vi.useRealTimers());

  it('never lets more than its capacity run at once, and starts waiters as slots free up', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const job = async () => {
      const release = await semaphore.acquire(10_000, tooSlow);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 12 }, job));
    expect(peak).toBe(2);
    expect(semaphore.inUse).toBe(0);
  });

  it('rejects a caller that waits longer than allowed, and leaves the queue consistent', async () => {
    vi.useFakeTimers();
    const semaphore = new Semaphore(1);
    const held = await semaphore.acquire(1_000, tooSlow);

    const waiting = semaphore.acquire(2_000, tooSlow);
    const assertion = expect(waiting).rejects.toThrow('no slot in time');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    held();
    // The timed-out waiter must not swallow the slot.
    const next = await semaphore.acquire(1_000, tooSlow);
    expect(semaphore.inUse).toBe(1);
    next();
    expect(semaphore.inUse).toBe(0);
  });

  it('releases a slot exactly once, however many times the release function is called', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire(1_000, tooSlow);
    release();
    release();
    release();
    const first = await semaphore.acquire(1_000, tooSlow);
    // Had the extra releases added capacity, a second acquire would be granted at once instead of waiting for `first`.
    const second = semaphore.acquire(5_000, tooSlow).then(() => 'granted');
    await expect(Promise.race([second, Promise.resolve('blocked')])).resolves.toBe('blocked');
    first();
    await expect(second).resolves.toBe('granted');
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});
