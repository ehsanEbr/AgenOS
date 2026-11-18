import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { SessionLifecycle } from '../../features/auth';
import { retryDelay, shouldRetry } from '../../shared/api/errors';
import { useUiPreferences } from '../state/ui-preferences.store';

export interface QueryClientOptions {
  /**
   * An additional callback for when the session ends. The application's own duty, forgetting the last-used organization, always runs
   * first (see `endSession`) and does not depend on this option. Must not navigate; the router follows the session state (ADR-0012 D4).
   */
  onSessionEnded?: () => void;
}

/**
 * What the application clears in the browser when a session ends (ADR-0012 D4 rule 5 step 4): the stored last-used organization, so
 * the next person to sign in on this browser never starts from the previous user's choice. The session lifecycle calls this only when
 * the new state is anonymous (a sign-out, a genuine `401`, a probe answering `401`), never for `unknown`.
 */
function endSession(extra?: () => void): () => void {
  return () => {
    useUiPreferences.getState().clearLastOrganization();
    extra?.();
  };
}

/**
 * Application-wide TanStack Query defaults. Individual queries override them only with a reason.
 *
 * - staleTime 30 s: data fetched a moment ago is shown from the cache instead of refetching on every mount.
 * - Queries retry at most twice, with backoff, and ONLY for recoverable failures (network, timeout, 502/503/504).
 *   Client errors (4xx), contract violations and cancellations are never retried: repeating them cannot help.
 * - Mutations never retry: repeating a write that may have succeeded is not safe without idempotency keys.
 *
 * The session lifecycle (ADR-0012 D4) is installed on BOTH caches: the `QueryCache` and the `MutationCache` call the same session
 * object, which ends the session on a genuine `401 unauthenticated`, purges private data, stamps requests with the session
 * generation, and refuses to run private requests unless the session is authenticated. No cache callback navigates.
 * The default `enabled` only keeps private queries idle (quietly) while the session is not authenticated. The binding gate is on the
 * query function itself (installed on `defaultQueryOptions`), so a query that sets its own `enabled` still cannot reach the network.
 */
export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const session = new SessionLifecycle({ onSessionEnded: endSession(options.onSessionEnded) });
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: session.onQueryError }),
    mutationCache: new MutationCache({ onMutate: session.onMutate, onError: session.onMutationError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        retryDelay,
        enabled: session.queryEnabled,
      },
      mutations: {
        retry: false,
      },
    },
  });
  session.attach(client);
  return client;
}
