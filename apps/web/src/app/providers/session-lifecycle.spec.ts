import {
  InfiniteQueryObserver,
  MutationObserver,
  QueriesObserver,
  QueryObserver,
  skipToken,
  type QueryClient,
} from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_KEY,
  SessionNotAuthenticatedError,
  isPrivateQueryKey,
  requireSessionLifecycle,
  type SessionUser,
  type SessionValue,
} from '../../features/auth';
import * as authFeature from '../../features/auth';
import { asAuthMutation, isAuthMutationMeta } from '../../features/auth/auth-mutation';
import { ApiClientError } from '../../shared/api/errors';
import { createQueryClient } from './query-client';

/*
 * The session lifecycle installed on both caches (ADR-0012 D4). Everything runs through the real createQueryClient, so the
 * QueryCache and MutationCache wiring is what is tested, not a copy of it.
 */

const user = (id: string): SessionUser => ({ id, email: `${id}@example.com`, displayName: id });
const signedIn = (id: string): SessionValue => ({ status: 'authenticated', user: user(id) });
const ANONYMOUS: SessionValue = { status: 'anonymous' };
/** The genuine authentication marker: only code inside features/auth can obtain it (tests may import the internal module). */
const AUTH_META = asAuthMutation({}).meta;
const UNKNOWN: SessionValue = { status: 'unknown' };

const failure = (status: number, code: string) =>
  new ApiClientError({ kind: 'http', message: 'x', status, code });
const sessionEnded = () => failure(401, 'unauthenticated');

function setup() {
  const onSessionEnded = vi.fn();
  const client = createQueryClient({ onSessionEnded });
  return { client, session: requireSessionLifecycle(client), onSessionEnded };
}

function deferred<T = never>() {
  let reject!: (reason: unknown) => void;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {
    resolvePromise = res;
    reject = rej;
  });
  return { promise, reject, resolve: resolvePromise };
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

/** A private query that is in flight until the returned deferred settles. The returned promise never rejects. */
function startQuery(client: QueryClient, key: readonly unknown[] = ['projects', 'list']) {
  const pending = deferred<string>();
  const settled = client
    .fetchQuery({ queryKey: key, queryFn: () => pending.promise, retry: false })
    .catch(() => undefined);
  return { pending, settled };
}

/** A mutation that is in flight until the returned deferred settles. The returned promise never rejects. */
function startMutation(client: QueryClient, meta?: Record<string, unknown>) {
  const pending = deferred<string>();
  const mutationFn = vi.fn(() => pending.promise);
  const result = new MutationObserver(client, { mutationFn, meta }).mutate(undefined);
  return { pending, mutationFn, result, settled: result.catch(() => undefined) };
}

const privateEntries = (client: QueryClient) =>
  client.getQueryCache().findAll({ predicate: (query) => isPrivateQueryKey(query.queryKey) });

/** Stops the cache from cancelling and removing private queries, to prove a result rests on the generation alone. */
function disablePurge(client: QueryClient) {
  vi.spyOn(client, 'cancelQueries').mockResolvedValue(undefined);
  vi.spyOn(client, 'removeQueries').mockImplementation(() => undefined);
}

describe('the session entry and the purge', () => {
  it('survives every purge, even when created by setQueryData with no metadata', () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'p');
    client.setQueryData(['organizations'], 'o');

    session.transition(ANONYMOUS);

    expect(client.getQueryData(SESSION_KEY)).toEqual(ANONYMOUS);
    const entry = client.getQueryCache().find({ queryKey: SESSION_KEY });
    expect(entry).toBeDefined();
    expect(entry?.meta).toBeUndefined(); // classification never depends on metadata
    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
    expect(client.getQueryData(['organizations'])).toBeUndefined();
  });

  it('keeps the public health data and removes every other root, a new unknown one included', () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['health', 'liveness'], 'up');
    client.setQueryData(['brand-new-feature', 'x'], 'secret');

    session.transition(ANONYMOUS);

    expect(client.getQueryData(['health', 'liveness'])).toBe('up');
    expect(client.getQueryData(['brand-new-feature', 'x'])).toBeUndefined();
  });

  it('purges when the session becomes unknown, and does not call the session-ended callback', () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'p');

    session.transition(UNKNOWN);

    expect(session.value).toEqual(UNKNOWN);
    expect(client.getQueryData(SESSION_KEY)).toEqual(UNKNOWN);
    expect(privateEntries(client)).toHaveLength(0);
    expect(session.owner).toBeNull();
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('removes private data that is present while anonymous when someone signs in (sign-in always purges)', () => {
    const { client, session } = setup();
    session.transition(ANONYMOUS);
    client.setQueryData(['projects', 'list'], 'left over');

    session.transition(signedIn('b'));

    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
    expect(session.value).toEqual(signedIn('b'));
    expect(session.owner).toBe('b');
  });
});

describe('the transition block', () => {
  it('purges BEFORE it publishes: a new identity is never visible while the previous identity data is cached', () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'a-data');
    const privateEntriesWhenSessionChanged: number[] = [];
    client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] === 'session')
        privateEntriesWhenSessionChanged.push(privateEntries(client).length);
    });

    session.transition(signedIn('b'));

    expect(privateEntriesWhenSessionChanged.length).toBeGreaterThan(0);
    expect(privateEntriesWhenSessionChanged.every((count) => count === 0)).toBe(true);
  });

  it('replaces the owner and the data when a different user appears, and increases the generation once', () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'a-data');
    const before = session.generation;

    session.transition(signedIn('b'));

    expect(session.generation).toBe(before + 1);
    expect(session.owner).toBe('b');
    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
  });

  it('does not treat the identity that is already published as a transition (refreshes it in place)', () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'a-data');
    const before = session.generation;

    session.transition({ status: 'authenticated', user: { ...user('a'), displayName: 'Renamed' } });

    expect(session.generation).toBe(before);
    expect(client.getQueryData(['projects', 'list'])).toBe('a-data');
    expect(session.value).toMatchObject({ user: { displayName: 'Renamed' } });
    session.transition(ANONYMOUS);
    session.transition(ANONYMOUS); // already anonymous
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('calls the session-ended callback only when the session becomes anonymous', () => {
    const { session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    expect(onSessionEnded).not.toHaveBeenCalled();
    session.transition(ANONYMOUS);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });
});

describe('the onSessionEnded contract', () => {
  it('is called with no arguments, after the purge and the publication: it observes the signed-out state', () => {
    let seen: { value: SessionValue; owner: string | null; privateEntries: number } | undefined;
    const client = createQueryClient({
      onSessionEnded: (...args: unknown[]) => {
        expect(args).toHaveLength(0);
        const lifecycle = requireSessionLifecycle(client);
        seen = {
          value: lifecycle.value,
          owner: lifecycle.owner,
          privateEntries: privateEntries(client).length,
        };
      },
    });
    const session = requireSessionLifecycle(client);
    session.transition(signedIn('a'));
    client.setQueryData(['projects', 'list'], 'p');

    session.transition(ANONYMOUS);

    expect(seen).toEqual({ value: ANONYMOUS, owner: null, privateEntries: 0 });
  });

  it('is called once per transition into anonymous across a whole cycle, and never for the other transitions', () => {
    const { session, onSessionEnded } = setup();

    session.transition(signedIn('a')); // unknown -> authenticated
    session.transition(signedIn('b')); // identity change
    session.transition(UNKNOWN); // authenticated -> unknown
    expect(onSessionEnded).not.toHaveBeenCalled();

    session.transition(ANONYMOUS); // unknown -> anonymous
    session.transition(ANONYMOUS); // already anonymous: not a transition
    expect(onSessionEnded).toHaveBeenCalledTimes(1);

    session.transition(signedIn('a')); // sign in again
    session.transition(ANONYMOUS); // a second, separate end
    expect(onSessionEnded).toHaveBeenCalledTimes(2);
  });

  it('is called once when several requests of the same session answer 401 at the same time, mixed queries and mutations', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const requests = [
      startQuery(client, ['projects', 'a']),
      startQuery(client, ['projects', 'b']),
      startMutation(client),
    ];

    for (const request of requests) request.pending.reject(sessionEnded());
    await Promise.all(requests.map((request) => request.settled));

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('is not called for an error that is not a genuine session end', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const query = startQuery(client);

    query.pending.reject(failure(401, 'invalid_credentials'));
    await query.settled;

    expect(onSessionEnded).not.toHaveBeenCalled();
  });
});

describe('which errors end the session', () => {
  it('a genuine 401 unauthenticated from a private QUERY ends it: anonymous, private data purged, callback once', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['organizations'], 'o');
    const before = session.generation;
    const query = startQuery(client);

    query.pending.reject(sessionEnded());
    await query.settled;

    expect(session.value).toEqual(ANONYMOUS);
    expect(session.owner).toBeNull();
    expect(session.generation).toBe(before + 1);
    expect(client.getQueryData(['organizations'])).toBeUndefined();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('a genuine 401 unauthenticated from a private MUTATION ends it the same way', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    client.setQueryData(['organizations'], 'o');
    const mutation = startMutation(client);

    mutation.pending.reject(sessionEnded());
    await mutation.settled;

    expect(session.value).toEqual(ANONYMOUS);
    expect(client.getQueryData(['organizations'])).toBeUndefined();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  const notAnEndedSession: [string, ApiClientError][] = [
    ['401 invalid_credentials (a failed sign-in)', failure(401, 'invalid_credentials')],
    ['401 with any other code', failure(401, 'authentication_unavailable')],
    ['403 forbidden', failure(403, 'forbidden')],
    ['404 not found', failure(404, 'project_not_found')],
    ['409 conflict', failure(409, 'project_archived')],
    ['422 invalid_current_password', failure(422, 'invalid_current_password')],
    ['429 rate limited', failure(429, 'too_many_attempts')],
    ['500 server error', failure(500, 'internal_error')],
    ['a network failure', new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' })],
  ];

  it.each(notAnEndedSession)(
    '%s does not end the session, from a query or from a mutation',
    async (_name, error) => {
      const { client, session, onSessionEnded } = setup();
      session.transition(signedIn('a'));
      client.setQueryData(['organizations'], 'o');
      const before = session.generation;
      const query = startQuery(client);
      const mutation = startMutation(client);

      query.pending.reject(error);
      mutation.pending.reject(error);
      await Promise.all([query.settled, mutation.settled]);

      expect(session.value).toEqual(signedIn('a'));
      expect(session.generation).toBe(before);
      expect(client.getQueryData(['organizations'])).toBe('o');
      expect(onSessionEnded).not.toHaveBeenCalled();
    },
  );

  it('an authentication mutation (asAuthMutation) is skipped even for a 401 unauthenticated', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const signOut = startMutation(client, AUTH_META);

    signOut.pending.reject(sessionEnded());
    await signOut.settled;

    expect(session.value).toEqual(signedIn('a'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a public query (health) is never a session event, even for a 401 unauthenticated', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const query = startQuery(client, ['health', 'liveness']);

    query.pending.reject(sessionEnded());
    await query.settled;

    expect(session.value).toEqual(signedIn('a'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', UNKNOWN],
    ['anonymous', ANONYMOUS],
  ])(
    'a 401 unauthenticated while the session is %s is ignored: no purge, no callback, no change',
    async (_name, state) => {
      const { client, session, onSessionEnded } = setup();
      session.transition(signedIn('a'));
      disablePurge(client); // the query survives the transition: only the state and the generation can stop its 401
      const query = startQuery(client); // it can only start while authenticated (the execution gate)
      session.transition(state);
      onSessionEnded.mockClear(); // reaching anonymous is itself a session end; only what happens next is under test
      const removed = vi.mocked(client.removeQueries);
      removed.mockClear();
      const generation = session.generation;
      const mutationEnded = deferred<string>();
      const authMutation = new MutationObserver(client, {
        mutationFn: () => mutationEnded.promise,
        meta: AUTH_META,
      }).mutate(undefined);
      const authSettled = authMutation.catch(() => undefined);

      query.pending.reject(sessionEnded());
      mutationEnded.reject(sessionEnded());
      await Promise.all([query.settled, authSettled]);

      expect(session.value).toEqual(state);
      expect(session.generation).toBe(generation);
      expect(removed).not.toHaveBeenCalled();
      expect(onSessionEnded).not.toHaveBeenCalled();
    },
  );
});

describe('simultaneous and stale 401 responses', () => {
  it('a burst of 401s from BOTH caches purges and ends the session exactly once', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const removed = vi.spyOn(client, 'removeQueries');
    const before = session.generation;
    const query = startQuery(client);
    const mutation = startMutation(client);

    query.pending.reject(sessionEnded());
    mutation.pending.reject(sessionEnded());
    await Promise.all([query.settled, mutation.settled]);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(session.generation).toBe(before + 1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(session.value).toEqual(ANONYMOUS);
  });

  it('a second 401 while cancelQueries is still pending finds the state already changed and does nothing', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    vi.spyOn(client, 'cancelQueries').mockReturnValue(new Promise(() => undefined)); // never settles
    const query = startQuery(client);
    const mutation = startMutation(client);

    query.pending.reject(sessionEnded());
    await flush();
    expect(session.value).toEqual(ANONYMOUS); // complete although the cancellation promise is still pending

    mutation.pending.reject(sessionEnded());
    await Promise.all([query.settled, mutation.settled]);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('a QUERY started in an earlier generation cannot end the new session, whatever cancellation did', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    disablePurge(client); // the query survives the transition, so only the generation can protect user B
    const query = startQuery(client);

    session.transition(signedIn('b'));
    query.pending.reject(sessionEnded());
    await query.settled;

    expect(session.value).toEqual(signedIn('b'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a MUTATION started in an earlier generation cannot end the new session', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const mutation = startMutation(client);

    session.transition(signedIn('b'));
    mutation.pending.reject(sessionEnded());
    await mutation.settled;

    expect(session.value).toEqual(signedIn('b'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a private query that starts while the session is not authenticated is refused, so it can never report a 401', async () => {
    const { client, session, onSessionEnded } = setup();
    const early = startQuery(client); // starts while unknown: the execution gate refuses it before it runs
    session.transition(signedIn('a'));

    await early.settled;

    expect(session.value).toEqual(signedIn('a'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a query that starts in the CURRENT generation after a transition can end the session', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    session.transition(signedIn('b'));
    const query = startQuery(client);

    query.pending.reject(sessionEnded());
    await query.settled;

    expect(session.value).toEqual(ANONYMOUS);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('a late mutation answer cannot repopulate purged data through the cache (invalidation only touches existing queries)', async () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    const mutation = startMutation(client);
    session.transition(ANONYMOUS);

    mutation.pending.resolve('done');
    await mutation.settled;
    await client.invalidateQueries({ queryKey: ['projects'] }); // what a feature's onSuccess does

    expect(privateEntries(client)).toHaveLength(0);
  });
});

describe('private requests do not run unless the session is authenticated', () => {
  const observe = (client: QueryClient, key: readonly unknown[], queryFn: () => Promise<string>) => {
    const observer = new QueryObserver(client, { queryKey: key, queryFn });
    return observer.subscribe(() => undefined);
  };

  it('a private query observer does not fetch while the session is unknown or anonymous', async () => {
    for (const state of [UNKNOWN, ANONYMOUS]) {
      const { client, session } = setup();
      session.transition(state);
      const queryFn = vi.fn().mockResolvedValue('x');
      const unsubscribe = observe(client, ['projects', 'list'], queryFn);
      await flush();
      expect(queryFn).not.toHaveBeenCalled();
      unsubscribe();
    }
  });

  it('a public query observer (health, session) always runs', async () => {
    const { client } = setup();
    const queryFn = vi.fn().mockResolvedValue('up');
    const unsubscribe = observe(client, ['health', 'liveness'], queryFn);
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('a private query observer fetches once the session is authenticated', async () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    const queryFn = vi.fn().mockResolvedValue('x');
    const unsubscribe = observe(client, ['projects', 'list'], queryFn);
    await flush();
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('a private mutation is refused locally, before it is sent, while the session is not authenticated', async () => {
    for (const state of [UNKNOWN, ANONYMOUS]) {
      const { client, session, onSessionEnded } = setup();
      session.transition(state);
      onSessionEnded.mockClear();
      const mutation = startMutation(client);

      await expect(mutation.result).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
      expect(mutation.mutationFn).not.toHaveBeenCalled();
      expect(onSessionEnded).not.toHaveBeenCalled();
    }
  });

  it('an authentication mutation (asAuthMutation) is neither refused nor stamped', async () => {
    for (const state of [UNKNOWN, ANONYMOUS]) {
      const { client, session } = setup();
      session.transition(state);
      const signIn = startMutation(client, AUTH_META);
      signIn.pending.resolve('ok');
      await expect(signIn.result).resolves.toBe('ok');
      expect(signIn.mutationFn).toHaveBeenCalledTimes(1);
    }
  });

  it('a private mutation runs while authenticated', async () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    const mutation = startMutation(client);
    mutation.pending.resolve('ok');
    await expect(mutation.result).resolves.toBe('ok');
    expect(mutation.mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe('the authentication-mutation exemption cannot be claimed through metadata', () => {
  // Everything a feature could write to look like an authentication mutation. None of it may count.
  const FORGERIES: [string, Record<string, unknown>][] = [
    ['auth: true', { auth: true }],
    ["auth: 'auth'", { auth: 'auth' }],
    ['auth: {}', { auth: {} }],
    ['a symbol from the global registry', { auth: Symbol.for('agentos.auth-mutation') }],
    ['an unrelated symbol', { auth: Symbol('auth') }],
  ];
  const NOT_AUTHENTICATED = [
    ['unknown', UNKNOWN],
    ['anonymous', ANONYMOUS],
  ] as const;

  it.each(FORGERIES)(
    'a private mutation with meta %s is refused locally while not authenticated',
    async (_name, meta) => {
      for (const [, state] of NOT_AUTHENTICATED) {
        const { client, session } = setup();
        session.transition(state);
        const mutation = startMutation(client, meta);

        await expect(mutation.result).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
        expect(mutation.mutationFn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(FORGERIES)(
    'a private mutation with meta %s is still a private mutation while authenticated: its 401 ends the session',
    async (_name, meta) => {
      const { client, session, onSessionEnded } = setup();
      session.transition(signedIn('a'));
      const mutation = startMutation(client, meta);

      mutation.pending.reject(sessionEnded());
      await mutation.settled;

      expect(session.value).toEqual(ANONYMOUS);
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the genuine authentication marker', () => {
  it('exempts exactly the mutations marked with it: they run while unknown or anonymous, and their 401 is not a session event', async () => {
    for (const state of [UNKNOWN, ANONYMOUS]) {
      const { client, session, onSessionEnded } = setup();
      session.transition(state);
      onSessionEnded.mockClear();
      const signIn = startMutation(client, AUTH_META);

      signIn.pending.reject(sessionEnded());
      await signIn.settled;

      expect(signIn.mutationFn).toHaveBeenCalledTimes(1);
      expect(onSessionEnded).not.toHaveBeenCalled();
    }
  });

  it('keeps the options and the other metadata of the mutation it marks', () => {
    const options = { mutationFn: vi.fn(), meta: { feature: 'auth' } };
    const marked = asAuthMutation(options);
    expect(marked.mutationFn).toBe(options.mutationFn);
    expect(marked.meta.feature).toBe('auth');
    expect(isAuthMutationMeta(marked.meta)).toBe(true);
    expect(isAuthMutationMeta(options.meta)).toBe(false);
  });

  it('is not reachable through the public entry of the auth feature (nothing it exports is, or returns, the marker)', () => {
    const marker = AUTH_META.auth;
    const exported = Object.entries(authFeature);
    expect(exported.length).toBeGreaterThan(0);
    for (const [name, value] of exported) {
      expect(name).not.toMatch(/AuthMutation/i);
      expect(value, name).not.toBe(marker);
    }
  });
});

describe('the gate holds even when a feature sets its own `enabled` (ADR-0012 D4 rule 5, execution gate)', () => {
  /** A private query function that reaches the network, so "never reached the network" can be asserted directly. */
  function networkQueryFn() {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const queryFn = vi.fn(async () => (await fetch('/api/v1/projects')).json());
    return { queryFn, fetchSpy };
  }
  const NOT_AUTHENTICATED = [
    ['unknown', UNKNOWN],
    ['anonymous', ANONYMOUS],
  ] as const;

  it.each(NOT_AUTHENTICATED)(
    'an observer with enabled: true cannot reach its queryFn or the network while %s',
    async (_name, state) => {
      const { client, session } = setup();
      session.transition(state);
      const { queryFn, fetchSpy } = networkQueryFn();
      const observer = new QueryObserver(client, { queryKey: ['projects', 'list'], queryFn, enabled: true });
      const unsubscribe = observer.subscribe(() => undefined);
      await flush();

      expect(queryFn).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(observer.getCurrentResult().error).toBeInstanceOf(SessionNotAuthenticatedError); // refused, not retried
      unsubscribe();
    },
  );

  it.each(NOT_AUTHENTICATED)(
    'an infinite-query observer with enabled: true cannot reach its queryFn or the network while %s',
    async (_name, state) => {
      const { client, session } = setup();
      session.transition(state);
      const { queryFn, fetchSpy } = networkQueryFn();
      const observer = new InfiniteQueryObserver(client, {
        queryKey: ['projects', 'pages'],
        queryFn,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        enabled: true,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      await flush();

      expect(queryFn).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it('a multi-query observer (useQueries) with enabled: true cannot reach its queryFn while unknown', async () => {
    const { client } = setup();
    const { queryFn, fetchSpy } = networkQueryFn();
    const observer = new QueriesObserver(client, [
      { queryKey: ['projects', 'a'], queryFn, enabled: true },
      { queryKey: ['organizations', 'b'], queryFn, enabled: true },
    ]);
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();

    expect(queryFn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('the imperative fetch methods cannot bypass it either (they are also banned by lint)', async () => {
    const { client } = setup();
    const { queryFn, fetchSpy } = networkQueryFn();

    await expect(client.fetchQuery({ queryKey: ['projects', 'f'], queryFn })).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError,
    );
    await client.prefetchQuery({ queryKey: ['projects', 'p'], queryFn });
    await expect(client.ensureQueryData({ queryKey: ['projects', 'e'], queryFn })).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError,
    );

    expect(queryFn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a queryFn that comes from setQueryDefaults is gated too', async () => {
    const { client } = setup();
    const { queryFn, fetchSpy } = networkQueryFn();
    client.setQueryDefaults(['projects'], { queryFn });
    const observer = new QueryObserver(client, { queryKey: ['projects', 'defaults'], enabled: true });
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();

    expect(queryFn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('a RETRY after the session ended does not run, even if cancellation did nothing', async () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    disablePurge(client); // the query survives the transition, so only the gate can stop the retry
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' }))
      .mockResolvedValue('should never run');
    const settled = client
      .fetchQuery({ queryKey: ['projects', 'retry'], queryFn, retry: 1, retryDelay: 20 })
      .catch((error: unknown) => error);

    await flush(); // the first attempt failed; the retry is waiting
    session.transition(ANONYMOUS);
    const outcome = await settled;

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(outcome).toBeInstanceOf(SessionNotAuthenticatedError);
  });

  it('an authenticated private query still runs, with the real context (key, signal, page parameter)', async () => {
    const { client, session } = setup();
    session.transition(signedIn('a'));
    const queryFn = vi.fn().mockResolvedValue('rows');
    const observer = new QueryObserver(client, { queryKey: ['projects', 'list'], queryFn, enabled: true });
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0]?.[0]).toMatchObject({ queryKey: ['projects', 'list'] });
    expect(queryFn.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(observer.getCurrentResult().data).toBe('rows');
    unsubscribe();

    const pages = vi.fn().mockResolvedValue(['p']);
    const infinite = new InfiniteQueryObserver(client, {
      queryKey: ['projects', 'pages'],
      queryFn: pages,
      initialPageParam: 7,
      getNextPageParam: () => undefined,
      enabled: true,
    });
    const unsubscribeInfinite = infinite.subscribe(() => undefined);
    await flush();
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages.mock.calls[0]?.[0]).toMatchObject({ pageParam: 7 });
    unsubscribeInfinite();
  });

  it('a 401 from a gated authenticated query still ends the session once (stamping is unaffected)', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('a'));
    const queryFn = vi.fn().mockRejectedValue(sessionEnded());
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['projects', 'pages'],
      queryFn,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      enabled: true,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await flush();

    expect(session.value).toEqual(ANONYMOUS);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it.each([
    ['health', ['health', 'liveness']],
    ['session', ['session']],
  ])(
    'a public %s query is left untouched and runs while unknown, with enabled: true',
    async (_name, queryKey) => {
      const { client } = setup();
      const queryFn = vi.fn().mockResolvedValue('public');
      const observer = new QueryObserver(client, { queryKey, queryFn, enabled: true });
      expect(observer.options.queryFn).toBe(queryFn); // not wrapped
      const unsubscribe = observer.subscribe(() => undefined);
      await flush();

      expect(queryFn).toHaveBeenCalledTimes(1);
      unsubscribe();
    },
  );

  it('wraps a private queryFn once and keeps its identity stable, so options do not churn on every render', () => {
    const { client } = setup();
    const queryFn = vi.fn();
    const first = client.defaultQueryOptions({ queryKey: ['projects', 'x'], queryFn });
    const second = client.defaultQueryOptions({ queryKey: ['projects', 'x'], queryFn });

    expect(first.queryFn).not.toBe(queryFn);
    expect(second.queryFn).toBe(first.queryFn);
    expect(client.defaultQueryOptions(first).queryFn).toBe(first.queryFn); // already defaulted: not wrapped again
  });

  it('leaves a query without a callable queryFn alone (skipToken, or none)', () => {
    const { client } = setup();
    expect(client.defaultQueryOptions({ queryKey: ['projects', 'x'], queryFn: skipToken }).queryFn).toBe(
      skipToken,
    );
    expect(client.defaultQueryOptions({ queryKey: ['projects', 'y'] }).queryFn).toBeUndefined();
  });
});

describe('the handlers never navigate or use the forbidden cache calls', () => {
  /** The source without comments: the files explain what they must never do, and the explanation is not a use. */
  const read = (relative: string) =>
    readFileSync(resolve(__dirname, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
  const sources = {
    'features/auth/session-lifecycle.ts': read('../../features/auth/session-lifecycle.ts'),
    'features/auth/session.ts': read('../../features/auth/session.ts'),
    'app/providers/query-client.ts': read('./query-client.ts'),
  };

  it.each(Object.entries(sources))(
    '%s has no router, location, history or navigation call',
    (_file, source) => {
      expect(source).not.toMatch(/from ['"]react-router/);
      expect(source).not.toMatch(
        /window\.location|\blocation\.(href|assign|replace)|\bhistory\.|\bnavigate\(/,
      );
    },
  );

  it.each(Object.entries(sources))(
    '%s never clears the client or invalidates without a filter',
    (_file, source) => {
      expect(source).not.toMatch(/\.clear\(\)/);
      expect(source).not.toMatch(/invalidateQueries\(\s*\)/);
    },
  );
});
