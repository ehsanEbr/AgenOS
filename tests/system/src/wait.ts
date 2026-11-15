export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

/**
 * Polls until `check` returns a truthy value and returns it. A bounded wait on a CONDITION (a container state, an HTTP status,
 * a job state), never a fixed sleep: it returns as soon as the condition holds and fails with a clear message otherwise.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 60_000, intervalMs = 500, message = 'condition' }: WaitOptions = {},
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

/**
 * The mirror of `waitFor` for "this must NOT happen". Absence cannot be observed without a window of time, so this is the one
 * bounded wait in the suite; it fails the moment the invariant breaks. Used only where no event exists to wait for.
 */
export async function staysTrue(
  check: () => boolean | Promise<boolean>,
  durationMs: number,
  message: string,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    if (!(await check())) throw new Error(`Invariant violated: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
}

/** HTTP status of a GET, or 0 when the connection fails (server down). Never throws. */
export async function httpStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}
