import type { QueryClient } from '@tanstack/react-query';
import { getMe } from './api';
import { ANONYMOUS_SESSION, SESSION_KEY, type SessionValue } from './session';
import { isSessionEnded, requireSessionLifecycle } from './session-lifecycle';

/**
 * The values the probe handed back to TanStack Query. Each return is a fresh copy, so membership identifies THAT return (and never a
 * shared constant such as `ANONYMOUS_SESSION`, which a transition may publish again later). Weak: it keeps nothing alive.
 */
const returnedByProbe = new WeakSet<object>();

/** What the probe hands back to TanStack Query: a marked copy of a value that is ALREADY published (see `keepPublishedSession`). */
function returned(value: SessionValue): SessionValue {
  const copy = { ...value } as SessionValue;
  returnedByProbe.add(copy);
  return copy;
}

/**
 * The session probe: the query function of the `['session']` entry (`GET /me`), following ADR-0012 D4 rule 5.
 *
 *  - It publishes through the lifecycle's transition block, INSIDE this function and before it returns, so the purge of a previous
 *    user's data happens before the new identity is visible.
 *  - It captures the generation when it starts and DISCARDS its answer if the generation changed meanwhile (a sign-in, a sign-out, a
 *    handled 401 finished first): an old probe can never overwrite a newer transition. A discarded probe returns the current value.
 *  - A failure that is not "the session ended" (network, timeout, 5xx) runs no transition and leaves the published value unchanged.
 *  - While a sign-out is unresolved it does not even send the request, and no answer can restore the session (rule 6).
 *  - What it returns is marked, because TanStack Query stores a returned value a few microtasks AFTER the return: see
 *    `keepPublishedSession`.
 */
export async function probeSession(client: QueryClient, signal?: AbortSignal): Promise<SessionValue> {
  const lifecycle = requireSessionLifecycle(client);
  if (lifecycle.signOutUnresolved) return returned(lifecycle.value);

  const startedIn = lifecycle.generation;
  let next: SessionValue;
  try {
    const { user } = await getMe(signal);
    next = {
      status: 'authenticated',
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  } catch (error) {
    if (!isSessionEnded(error)) throw error;
    next = ANONYMOUS_SESSION;
  }

  if (lifecycle.generation !== startedIn || lifecycle.signOutUnresolved) return returned(lifecycle.value);
  lifecycle.transition(next);
  return returned(next);
}

/**
 * The store guard of the session query (`structuralSharing`, which TanStack Query calls with the value currently in the cache and
 * the value it is about to store, at the moment of the store).
 *
 * The ordering it closes: the probe publishes through the lifecycle and returns; TanStack Query stores the returned value only after
 * a few microtasks (`Promise.resolve(result).then(store)`), and a microtask that was queued earlier runs BEFORE that store. If it is a
 * newer transition (a sign-out continuation, a handled 401), the late store would put the older value over it: the cache would say
 * "signed in" while the lifecycle has already purged and cleared its owner.
 *
 * Whatever the probe returns is ALREADY published (the probe publishes before it returns, or hands back the current value), so at the
 * moment of the store the cache holds that very value or a newer one. A probe-returned value therefore never replaces what is in the
 * cache. Values that did not come from the probe (every transition's own publication) are always stored.
 */
export function keepPublishedSession(previous: unknown, next: unknown): unknown {
  const fromProbe = typeof next === 'object' && next !== null && returnedByProbe.has(next);
  return fromProbe && previous !== undefined ? previous : next;
}

/** The options of the `['session']` query, in one place: the hook uses them, and so do the tests that drive the real probe. */
export function sessionQueryOptions(client: QueryClient) {
  const lifecycle = requireSessionLifecycle(client);
  return {
    queryKey: SESSION_KEY,
    queryFn: ({ signal }: { signal: AbortSignal }) => probeSession(client, signal),
    // No probe while a sign-out is unresolved (a probe could say "still signed in" about a logout that has not finished).
    enabled: () => !lifecycle.signOutUnresolved,
    structuralSharing: keepPublishedSession,
  };
}
