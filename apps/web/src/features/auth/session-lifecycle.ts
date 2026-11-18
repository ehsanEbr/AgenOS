import { IDENTITY_ERROR_CODES } from '@agentos/contracts';
import type { Mutation, Query, QueryClient } from '@tanstack/react-query';
import { isApiClientError } from '../../shared/api/errors';
import { isAuthMutationMeta } from './auth-mutation';
import { SESSION_KEY, UNKNOWN_SESSION, isPrivateQueryKey, isSameSession, type SessionValue } from './session';

/** Thrown, locally and before anything is sent, when a private mutation starts while the session is not authenticated. */
export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super('A private request was refused because the session is not authenticated');
    this.name = 'SessionNotAuthenticatedError';
  }
}

export interface SessionLifecycleOptions {
  /**
   * The session-ended callback (a deferred integration point: nothing is wired to it yet).
   *
   * Contract:
   *  - It is called exactly ONCE per transition INTO the anonymous state, and never for any other transition (authenticated,
   *    unknown) nor when anonymous is published again (that is not a transition). Repeated or concurrent 401s cannot call it twice
   *    for the same transition: the first one performs the transition, the others find the state already changed.
   *  - It is called synchronously at the END of the transition, after the private data was purged and the anonymous value published
   *    and the generation increased, so what it observes is already the signed-out state.
   *  - It takes no arguments, must not throw, and must not navigate: navigation follows the session state in the router, never a
   *    cache callback. The application will use it to clear what belongs to the signed-in user in the browser (the stored last-used
   *    organization).
   */
  onSessionEnded?: () => void;
}

/** A query function as TanStack Query calls it: with the query function context (key, signal, page parameter, ...). */
type QueryFunction = (context: unknown) => unknown;

const lifecycles = new WeakMap<QueryClient, SessionLifecycle>();

/** The lifecycle installed on a client by `createQueryClient`. */
export function requireSessionLifecycle(client: QueryClient): SessionLifecycle {
  const lifecycle = lifecycles.get(client);
  if (!lifecycle)
    throw new Error('This query client has no session lifecycle (create it with createQueryClient)');
  return lifecycle;
}

/** Only the genuine marker of `auth-mutation.ts` counts; metadata a feature writes by hand never does. */
const isAuthMutation = (mutation: Mutation<unknown, unknown, unknown, unknown>) =>
  isAuthMutationMeta(mutation.options.meta);

/** A `401` that means "your session ended". `invalid_credentials` (a failed sign-in) and every other error do not qualify. */
export function isSessionEnded(error: unknown): boolean {
  return (
    isApiClientError(error) && error.status === 401 && error.code === IDENTITY_ERROR_CODES.unauthenticated
  );
}

/**
 * The session transition contract of ADR-0012 D4 (rules 2 to 5), for one query client.
 *
 * Every change of who is signed in goes through `transition`, which runs ONE ordered block with no `await` inside it: increase the
 * generation, purge the private data if the identity is not the owner's, publish the session value, set the owner, and (when the
 * session ended) call the session-ended callback. Because the block is synchronous, no other callback can run inside it: a second
 * `401` from the QueryCache or the MutationCache runs either before it (and performs it) or after it (and finds the state changed).
 *
 * Every private request records the generation when it starts. A `401` ends the session only if the session is authenticated and
 * the request's recorded generation is the current one, so a late answer to a previous session's request (or to a request that never
 * ran as part of this session) is ignored, whatever cancellation did. Private requests do not run unless authenticated.
 *
 * What is NOT here (later steps): the session probe (`GET /me`), `RequireAuth`, sign-in and sign-out, and the unresolved-sign-out
 * handling of rule 6. They call `transition` and `generation`.
 */
export class SessionLifecycle {
  private client: QueryClient | undefined;
  private currentGeneration = 0;
  private ownerId: string | null = null;
  /** The generation each private query fetch and mutation started in. Weak: it never keeps a request alive. */
  private readonly stamps = new WeakMap<object, number>();
  /** The gated wrapper of each private query function, and the set of wrappers (so a wrapper is never wrapped again). */
  private readonly guardOf = new WeakMap<object, QueryFunction>();
  private readonly guards = new WeakSet<object>();

  constructor(private readonly options: SessionLifecycleOptions = {}) {}

  /** Binds the lifecycle to its client. Called once, by `createQueryClient`, right after the client exists. */
  attach(client: QueryClient): void {
    if (this.client) throw new Error('The session lifecycle is already attached to a query client');
    this.client = client;
    lifecycles.set(client, this);
    // A fetch of a private query records the generation it starts in. The event is delivered synchronously inside the dispatch.
    client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'fetch') return;
      const query = event.query;
      if (!isPrivateQueryKey(query.queryKey)) return;
      if (this.isAuthenticated()) this.stamps.set(query, this.currentGeneration);
      else this.stamps.delete(query); // started while not authenticated: it can never match a generation
    });
    // The session entry is never garbage-collected (ADR-0012 D4 rule 2). A default, not an option of one observer: the entry is also
    // created by `setQueryData` (every transition), possibly before any observer exists, and it must outlive all of them. Collecting
    // it would leave the owner of the private cache pointing at a session value that no longer exists.
    client.setQueryDefaults(SESSION_KEY, { gcTime: Infinity });
    // The execution gate (below) is installed on the one funnel every query option passes through.
    const defaultQueryOptions = client.defaultQueryOptions.bind(client);
    client.defaultQueryOptions = ((options: Parameters<QueryClient['defaultQueryOptions']>[0]) =>
      this.guardQueryOptions(defaultQueryOptions(options))) as QueryClient['defaultQueryOptions'];
  }

  /** Increased by every transition. A probe or a sign-out captures it when it starts and discards its answer if it changed. */
  get generation(): number {
    return this.currentGeneration;
  }

  /** The id of the user whose data the private cache holds, or null. */
  get owner(): string | null {
    return this.ownerId;
  }

  /** The published session value. An entry with no value yet is unknown. */
  get value(): SessionValue {
    return this.attached().getQueryData<SessionValue>(SESSION_KEY) ?? UNKNOWN_SESSION;
  }

  isAuthenticated(): boolean {
    return this.value.status === 'authenticated';
  }

  /** A sign-out whose outcome is uncertain is waiting to be completed (rule 6): no probe may run and none may restore the session. */
  get signOutUnresolved(): boolean {
    const value = this.value;
    return value.status === 'unknown' && value.signOutUnresolved === true;
  }

  /**
   * Moves the session to `next`. Publishing the identity that is already published is not a transition: nothing is purged and the
   * generation does not change (an authenticated value is refreshed in place).
   */
  transition(next: SessionValue): void {
    const client = this.attached();
    const current = this.value;
    if (isSameSession(current, next)) {
      if (next.status === 'authenticated') client.setQueryData(SESSION_KEY, next);
      return;
    }

    this.currentGeneration += 1;
    // The purge comes BEFORE the publication: a new identity is never visible while the previous one's data is still cached.
    if (next.status !== 'authenticated' || next.user.id !== this.ownerId) this.purgePrivateData();
    client.setQueryData(SESSION_KEY, next);
    this.ownerId = next.status === 'authenticated' ? next.user.id : null;
    if (next.status === 'anonymous') this.options.onSessionEnded?.();
  }

  /**
   * Cancels, then removes, every private query. Cancellation is requested synchronously; the promise `cancelQueries` returns is not
   * awaited and nothing depends on it. Removal destroys the queries, so a late response cannot write into the cache. The session
   * entry and the public roots are never touched. Idempotent. (Never `queryClient.clear()` and never an unfiltered invalidation.)
   */
  private purgePrivateData(): void {
    const client = this.attached();
    const filters = { predicate: (query: Query) => isPrivateQueryKey(query.queryKey) };
    void client.cancelQueries(filters).catch(() => undefined);
    client.removeQueries(filters);
  }

  /** The `QueryCache` `onError` callback. */
  readonly onQueryError = (error: unknown, query: Query<unknown, unknown, unknown>): void => {
    this.endSessionIfCurrent(error, query);
  };

  /** The `MutationCache` `onError` callback. Authentication mutations handle their own outcome and are skipped. */
  readonly onMutationError = (
    error: unknown,
    _variables: unknown,
    _onMutateResult: unknown,
    mutation: Mutation<unknown, unknown, unknown, unknown>,
  ): void => {
    if (isAuthMutation(mutation)) return;
    this.endSessionIfCurrent(error, mutation);
  };

  /**
   * The `MutationCache` start callback: records the generation, and refuses a private mutation locally, before it is sent, when
   * the session is not authenticated. Authentication mutations (marked with `asAuthMutation`, which only this feature can use) are neither stamped nor refused.
   */
  readonly onMutate = (_variables: unknown, mutation: Mutation<unknown, unknown, unknown, unknown>): void => {
    if (isAuthMutation(mutation)) return;
    if (!this.isAuthenticated()) throw new SessionNotAuthenticatedError();
    this.stamps.set(mutation, this.currentGeneration);
  };

  /**
   * The client's default `enabled` option: public roots always, every other query only while authenticated. This is the QUIET layer
   * (an idle query, no error). It is only a default: a query that sets its own `enabled` replaces it, which is why the real gate is
   * `guardQueryOptions`.
   */
  readonly queryEnabled = (query: { readonly queryKey: readonly unknown[] }): boolean =>
    !isPrivateQueryKey(query.queryKey) || this.isAuthenticated();

  /**
   * The execution gate (ADR-0012 D4 rule 5): the `queryFn` of every private query is wrapped so that it throws
   * `SessionNotAuthenticatedError`, before anything reaches the network, unless the session is authenticated AT THE MOMENT IT RUNS.
   * It does not depend on `enabled`, so a feature cannot bypass it by setting its own; it covers every way a query function runs,
   * because TanStack Query resolves options for observers, infinite queries, `useQueries`, the imperative fetch methods, hydration
   * and `setQueryDefaults` through `QueryClient.defaultQueryOptions`, and runs the retries of a query through the same function.
   * Public roots are left untouched. The wrapper of a function is created once, so option identity stays stable across renders.
   */
  private guardQueryOptions<T extends { queryKey?: readonly unknown[]; queryFn?: unknown }>(options: T): T {
    const queryFn = options.queryFn;
    if (typeof queryFn !== 'function' || !options.queryKey || !isPrivateQueryKey(options.queryKey))
      return options;
    if (this.guards.has(queryFn)) return options; // options that were already defaulted come back through here
    let guarded = this.guardOf.get(queryFn);
    if (!guarded) {
      const run = queryFn as QueryFunction;
      guarded = (context) => {
        if (!this.isAuthenticated()) throw new SessionNotAuthenticatedError();
        return run(context);
      };
      this.guardOf.set(queryFn, guarded);
      this.guards.add(guarded);
    }
    return { ...options, queryFn: guarded };
  }

  /**
   * The acceptance rule for a `401` (rule 5): act only on a genuine `unauthenticated` 401, only while authenticated, and only for a
   * request recorded in the current generation. Anything else is ignored: no purge, no navigation, no message.
   */
  private endSessionIfCurrent(error: unknown, request: object): void {
    if (!isSessionEnded(error)) return;
    if (!this.isAuthenticated()) return;
    const startedIn = this.stamps.get(request);
    if (startedIn === undefined || startedIn !== this.currentGeneration) return;
    this.transition({ status: 'anonymous' });
  }

  private attached(): QueryClient {
    if (!this.client) throw new Error('The session lifecycle is not attached to a query client');
    return this.client;
  }
}
