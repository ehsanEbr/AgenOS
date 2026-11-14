import { QueryClient } from '@tanstack/react-query';
import { retryDelay, shouldRetry } from '../../shared/api/errors';

/**
 * Application-wide TanStack Query defaults. Individual queries override them only with a reason.
 *
 * - staleTime 30 s: data fetched a moment ago is shown from the cache instead of refetching on every mount.
 * - Queries retry at most twice, with backoff, and ONLY for recoverable failures (network, timeout, 502/503/504).
 *   Client errors (4xx), contract violations and cancellations are never retried: repeating them cannot help.
 * - Mutations never retry: repeating a write that may have succeeded is not safe without idempotency keys.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        retryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
