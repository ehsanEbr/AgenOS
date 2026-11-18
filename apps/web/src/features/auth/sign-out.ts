import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { logout } from './api';
import { asAuthMutation } from './auth-mutation';
import { ANONYMOUS_SESSION, UNRESOLVED_SIGN_OUT } from './session';
import { isSessionEnded, requireSessionLifecycle, type SessionLifecycle } from './session-lifecycle';

/*
 * Sign-out (ADR-0012 D4 rule 6).
 *
 *   204, or 401 unauthenticated (the session was already over)  -> definite: the session becomes anonymous.
 *   anything else (network, timeout, 5xx, any other outcome)    -> UNCERTAIN: the server may or may not have ended the HttpOnly
 *                                                                  session. The session becomes UNKNOWN with the sign-out
 *                                                                  unresolved: the private UI is gone, the private cache purged, and
 *                                                                  the logout is sent again, once, automatically.
 *
 * Why a repeat and never a `GET /me` probe: the logout is one transaction whose revocation is invisible to other connections until it
 * commits, and nothing cancels it when the client gives up, so a probe can answer "still signed in" while the logout is still
 * running. A repeated logout is conclusive: `204` or `401` both mean the session is revoked and committed.
 */

type Attempt = 'ended' | 'uncertain' | 'superseded';

/** One logout request. `superseded` when another transition (a sign-in, a handled 401) happened while it was in flight. */
async function attempt(lifecycle: SessionLifecycle): Promise<Attempt> {
  const startedIn = lifecycle.generation;
  let result: Attempt;
  try {
    await logout();
    result = 'ended';
  } catch (error) {
    result = isSessionEnded(error) ? 'ended' : 'uncertain';
  }
  return lifecycle.generation === startedIn ? result : 'superseded';
}

/** Sign-outs the user asked for, so the redirect that follows is not announced as "your session ended". */
const deliberate = new WeakSet<QueryClient>();

/** Did a sign-out the user asked for end the current anonymous state? A pure read (render may call it any number of times). */
export function isDeliberateSignOut(client: QueryClient): boolean {
  return deliberate.has(client);
}

/** Forgets it: called when a new sign-out starts and when someone signs in. */
export function clearDeliberateSignOut(client: QueryClient): void {
  deliberate.delete(client);
}

const inFlight = new WeakMap<QueryClient, Promise<void>>();

/**
 * Signs out. One request at a time: a second call while one is in flight shares it (repeated clicks send one request).
 * Called while the sign-out is already unresolved (the Retry button) it sends exactly one request. Called while authenticated it
 * sends one request and, if that is uncertain, repeats it once.
 */
export function signOut(client: QueryClient): Promise<void> {
  const running = inFlight.get(client);
  if (running) return running;

  const lifecycle = requireSessionLifecycle(client);
  const run = async (): Promise<void> => {
    clearDeliberateSignOut(client);
    const wasUnresolved = lifecycle.signOutUnresolved;
    let outcome = await attempt(lifecycle);
    if (outcome === 'uncertain' && !wasUnresolved) {
      lifecycle.transition(UNRESOLVED_SIGN_OUT); // fail closed: unmount the private UI and purge before anything else
      outcome = await attempt(lifecycle); // the single automatic repeat
    }
    if (outcome === 'ended') {
      deliberate.add(client);
      lifecycle.transition(ANONYMOUS_SESSION);
    }
    // 'superseded': a newer transition owns the state. 'uncertain' after the repeat: the value stays unresolved and Retry is offered.
  };
  const promise = run().finally(() => inFlight.delete(client));
  inFlight.set(client, promise);
  return promise;
}

/** The sign-out as a mutation, for the controls that show its pending state. It is an authentication mutation (genuine marker). */
export function useSignOut() {
  const client = useQueryClient();
  return useMutation(asAuthMutation({ mutationFn: () => signOut(client) }));
}
