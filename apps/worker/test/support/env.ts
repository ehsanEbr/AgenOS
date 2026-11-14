import { randomBytes } from 'node:crypto';

/** The Redis from `pnpm infra:up`, moved to logical database 15 so tests never touch development queues. */
export function testRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  url.pathname = '/15';
  return url.toString();
}

/** Each test gets its own queue namespace, so tests cannot see (or break) each other's jobs. */
export const uniquePrefix = (): string => `it-${randomBytes(5).toString('hex')}`;

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

/**
 * Polls until `check` returns a truthy value (or stops throwing) and returns it. This is a bounded wait on a CONDITION, not a
 * fixed sleep: it returns as soon as the condition holds and fails with a clear message if it never does.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 20_000, intervalMs = 25, message = 'condition' }: WaitOptions = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${message}${lastError ? `: ${String(lastError)}` : ''}`,
  );
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
