/**
 * A counting semaphore with a bounded wait. It caps how many password hashes run at once in THIS process (ADR-0010, decision 3:
 * two per API process; it is not a global limit and does not coordinate between replicas). A caller that cannot get a slot in time
 * is told so instead of queueing without bound.
 */
export class Semaphore {
  private available: number;
  private readonly waiting: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new Error('Semaphore capacity must be a positive integer');
    this.available = capacity;
  }

  /** Resolves with a function that releases the slot exactly once, or rejects with `onTimeout()` after `waitMs`. */
  acquire(waitMs: number, onTimeout: () => Error): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(onTimeout());
        }, waitMs),
      };
      this.waiting.push(entry);
    });
  }

  /** Slots in use right now (for tests and diagnostics). */
  get inUse(): number {
    return this.capacity - this.available;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next)
        next.grant(); // the slot passes straight to the next waiter
      else this.available += 1;
    };
  }
}
