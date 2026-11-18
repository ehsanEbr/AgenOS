import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/providers/query-client';
import { ApiClientError } from '../../shared/api/errors';
import {
  invalidCredentialsError,
  jsonResponse,
  loginOk,
  meOk,
  mockFetch,
  testUser,
  unauthenticatedError,
} from '../../test/fixtures/api';
import { isPrivateQueryKey } from './session';
import { requireSessionLifecycle } from './session-lifecycle';
import { probeSession } from './session-probe';
import { ANONYMOUS_SESSION, UNRESOLVED_SIGN_OUT, type SessionValue } from './session';
import { clearDeliberateSignOut, isDeliberateSignOut, signOut } from './sign-out';
import { useSignIn } from './use-session';

/*
 * The session flows of ADR-0012 D4 rules 5 and 6 at the client level: the probe (GET /me), sign-out with its uncertain outcomes, and
 * sign-in. Everything runs through the real createQueryClient and the real apiRequest; only `fetch` is faked.
 */

const signedIn = (id = testUser.id): SessionValue => ({
  status: 'authenticated',
  user: { id, email: `${id}@example.com`, displayName: id },
});

function setup() {
  const onSessionEnded = vi.fn();
  const client = createQueryClient({ onSessionEnded });
  return { client, session: requireSessionLifecycle(client), onSessionEnded };
}

const privateEntries = (client: ReturnType<typeof createQueryClient>) =>
  client.getQueryCache().findAll({ predicate: (query) => isPrivateQueryKey(query.queryKey) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const calls = (spy: ReturnType<typeof mockFetch>, suffix: string) =>
  spy.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length;

const unauthenticated = () => jsonResponse(unauthenticatedError, 401);
const down = () => {
  throw new TypeError('Failed to fetch');
};

describe('the session probe (GET /me)', () => {
  it('a 200 makes the session authenticated: publishes the user, owns the cache, increases the generation', async () => {
    const { client, session } = setup();
    const spy = mockFetch(() => jsonResponse(meOk));
    const generation = session.generation;

    const value = await probeSession(client);

    expect(value).toEqual({
      status: 'authenticated',
      user: { id: testUser.id, email: testUser.email, displayName: testUser.displayName },
    });
    expect(session.value).toEqual(value);
    expect(session.owner).toBe(testUser.id);
    expect(session.generation).toBe(generation + 1);
    expect(calls(spy, '/me')).toBe(1);
  });

  it('a 401 unauthenticated makes it anonymous and calls the session-ended callback once', async () => {
    const { client, session, onSessionEnded } = setup();
    mockFetch(unauthenticated);

    await expect(probeSession(client)).resolves.toEqual(ANONYMOUS_SESSION);

    expect(session.value).toEqual(ANONYMOUS_SESSION);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network failure', down],
    ['a 500', () => jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500)],
    ['a 503', () => jsonResponse({ code: 'unavailable', message: 'x', correlationId: 'c' }, 503)],
  ])('%s runs no transition: the value stays unknown', async (_name, answer) => {
    const { client, session, onSessionEnded } = setup();
    mockFetch(answer);
    const generation = session.generation;

    await expect(probeSession(client)).rejects.toBeInstanceOf(ApiClientError);

    expect(session.value).toEqual({ status: 'unknown' });
    expect(session.generation).toBe(generation);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a failed check of an authenticated session changes nothing (it is not a session event)', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn());
    client.setQueryData(['projects', 'list'], 'kept');
    mockFetch(down);

    await expect(probeSession(client)).rejects.toBeInstanceOf(ApiClientError);

    expect(session.value).toEqual(signedIn());
    expect(client.getQueryData(['projects', 'list'])).toBe('kept');
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a 401 while authenticated ends the session and purges the private data', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn());
    client.setQueryData(['projects', 'list'], 'private');
    mockFetch(unauthenticated);

    await probeSession(client);

    expect(session.value).toEqual(ANONYMOUS_SESSION);
    expect(privateEntries(client)).toHaveLength(0);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('a different user found while the cache belongs to another is published only AFTER the purge', async () => {
    const { client, session } = setup();
    session.transition(signedIn('someone-else'));
    client.setQueryData(['projects', 'list'], 'theirs');
    const privateWhenPublished: number[] = [];
    client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey[0] === 'session')
        privateWhenPublished.push(privateEntries(client).length);
    });
    mockFetch(() => jsonResponse(meOk));

    await probeSession(client);

    expect(session.owner).toBe(testUser.id);
    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
    expect(privateWhenPublished.length).toBeGreaterThan(0);
    expect(privateWhenPublished.every((count) => count === 0)).toBe(true);
  });

  it('the same user again only refreshes the value: no purge, no new generation', async () => {
    const { client, session } = setup();
    mockFetch(() => jsonResponse(meOk));
    await probeSession(client);
    client.setQueryData(['projects', 'list'], 'kept');
    const generation = session.generation;

    await probeSession(client);

    expect(session.generation).toBe(generation);
    expect(client.getQueryData(['projects', 'list'])).toBe('kept');
  });

  it('a probe that answers after a sign-in finished is DISCARDED: it cannot overwrite the newer session', async () => {
    const { client, session } = setup();
    const answer = deferred<Response>();
    mockFetch(() => answer.promise);
    const probe = probeSession(client);

    session.transition(signedIn('signed-in-meanwhile')); // a sign-in finished while the probe was in flight
    const generation = session.generation;
    answer.resolve(jsonResponse(meOk)); // the probe now answers with a DIFFERENT user
    const result = await probe;

    expect(result).toEqual(signedIn('signed-in-meanwhile'));
    expect(session.value).toEqual(signedIn('signed-in-meanwhile'));
    expect(session.generation).toBe(generation);
  });

  it('a probe that answers after a sign-out finished does not bring the user back', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    const answer = deferred<Response>();
    mockFetch(() => answer.promise);
    const probe = probeSession(client);

    session.transition(ANONYMOUS_SESSION);
    answer.resolve(jsonResponse(meOk));
    await probe;

    expect(session.value).toEqual(ANONYMOUS_SESSION);
  });

  it('while a sign-out is unresolved the probe sends no request and restores nothing', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    session.transition(UNRESOLVED_SIGN_OUT);
    const spy = mockFetch(() => jsonResponse(meOk)); // the backend race: a probe could say "still signed in"

    await expect(probeSession(client)).resolves.toEqual(UNRESOLVED_SIGN_OUT);

    expect(spy).not.toHaveBeenCalled();
    expect(session.value).toEqual(UNRESOLVED_SIGN_OUT);
  });

  it('a probe already in flight when a sign-out becomes unresolved is discarded, even if it answers 200 with the user', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    const answer = deferred<Response>();
    mockFetch(() => answer.promise);
    const probe = probeSession(client);

    session.transition(UNRESOLVED_SIGN_OUT);
    answer.resolve(jsonResponse(meOk));
    await probe;

    expect(session.value).toEqual(UNRESOLVED_SIGN_OUT);
  });
});

describe('sign-out (ADR-0012 D4 rule 6)', () => {
  it('204 ends the session: anonymous, private data purged, callback once, and the redirect is not "your session ended"', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn());
    client.setQueryData(['projects', 'list'], 'private');
    const spy = mockFetch(() => new Response(null, { status: 204 }));

    await signOut(client);

    expect(session.value).toEqual(ANONYMOUS_SESSION);
    expect(privateEntries(client)).toHaveLength(0);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(isDeliberateSignOut(client)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('401 unauthenticated (the session was already over) is a definite outcome too', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    const spy = mockFetch(unauthenticated);

    await signOut(client);

    expect(session.value).toEqual(ANONYMOUS_SESSION);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network failure', down],
    ['a timeout-like network failure', down],
    ['a 500', () => jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500)],
    ['a 502', () => jsonResponse({ code: 'bad_gateway', message: 'x', correlationId: 'c' }, 502)],
    ['a 503', () => jsonResponse({ code: 'unavailable', message: 'x', correlationId: 'c' }, 503)],
    ['a 429', () => jsonResponse({ code: 'too_many_attempts', message: 'x', correlationId: 'c' }, 429)],
    [
      'a 403 (origin not allowed)',
      () => jsonResponse({ code: 'origin_not_allowed', message: 'x', correlationId: 'c' }, 403),
    ],
    ['a 401 with another code', () => jsonResponse(invalidCredentialsError, 401)],
  ])(
    'an uncertain outcome (%s) fails closed, then repeats the logout once and ends the session when the repeat is definite',
    async (_name, firstAnswer) => {
      const { client, session, onSessionEnded } = setup();
      session.transition(signedIn());
      client.setQueryData(['projects', 'list'], 'private');
      const seenDuringRepeat: { value: SessionValue; privateEntries: number; sessionRequests: number }[] = [];
      let request = 0;
      const spy = mockFetch(({ url }) => {
        request += 1;
        if (request === 1) return firstAnswer();
        // The repeat is on its way: by now the private UI must be gone and the cache purged.
        seenDuringRepeat.push({
          value: session.value,
          privateEntries: privateEntries(client).length,
          sessionRequests: calls(spy, '/me'),
        });
        expect(url.pathname).toMatch(/\/auth\/logout$/);
        return new Response(null, { status: 204 });
      });

      await signOut(client);

      expect(seenDuringRepeat).toEqual([
        { value: UNRESOLVED_SIGN_OUT, privateEntries: 0, sessionRequests: 0 },
      ]);
      expect(session.value).toEqual(ANONYMOUS_SESSION);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(calls(spy, '/me')).toBe(0); // never settled by a probe
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    },
  );

  it('when the repeat is uncertain too the sign-out stays unresolved: two requests, no probe, no callback, Retry offered', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn());
    const spy = mockFetch(down);

    await signOut(client);

    expect(session.value).toEqual(UNRESOLVED_SIGN_OUT);
    expect(session.signOutUnresolved).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('Retry from the unresolved state sends exactly ONE request, and a definite answer ends the session', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn());
    mockFetch(down);
    await signOut(client);
    const spy = mockFetch(() => new Response(null, { status: 204 }));

    await signOut(client);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(session.value).toEqual(ANONYMOUS_SESSION);
    expect(session.signOutUnresolved).toBe(false);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('a Retry that is uncertain again sends one request and stays unresolved without changing the generation', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    mockFetch(down);
    await signOut(client);
    const generation = session.generation;
    const spy = mockFetch(down);

    await signOut(client);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(session.value).toEqual(UNRESOLVED_SIGN_OUT);
    expect(session.generation).toBe(generation);
  });

  it('repeated clicks while a sign-out is in flight share ONE request', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);

    const first = signOut(client);
    const second = signOut(client);
    const third = signOut(client);
    answer.resolve(new Response(null, { status: 204 }));
    await Promise.all([first, second, third]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(session.value).toEqual(ANONYMOUS_SESSION);
  });

  it('a sign-in that finishes while the logout is in flight wins: the late logout outcome cannot end the new session', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('first'));
    const answer = deferred<Response>();
    mockFetch(() => answer.promise);

    const running = signOut(client);
    session.transition(signedIn('second')); // someone signed in meanwhile
    const generation = session.generation;
    answer.resolve(new Response(null, { status: 204 }));
    await running;

    expect(session.value).toEqual(signedIn('second'));
    expect(session.generation).toBe(generation);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('an uncertain outcome that arrives after a newer transition does not make the new session unresolved', async () => {
    const { client, session } = setup();
    session.transition(signedIn('first'));
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);

    const running = signOut(client);
    session.transition(signedIn('second'));
    answer.resolve(jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500));
    await running;

    expect(session.value).toEqual(signedIn('second'));
    expect(spy).toHaveBeenCalledTimes(1); // and no automatic repeat for a session that is not the one being signed out
  });

  it('the "deliberate" mark is a pure read that a new sign-out or a sign-in clears', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    mockFetch(() => new Response(null, { status: 204 }));
    await signOut(client);

    expect(isDeliberateSignOut(client)).toBe(true);
    expect(isDeliberateSignOut(client)).toBe(true); // reading does not consume it (React may render twice)
    clearDeliberateSignOut(client);
    expect(isDeliberateSignOut(client)).toBe(false);
  });
});

describe('sign-in (an authentication mutation)', () => {
  function hook(client: ReturnType<typeof createQueryClient>) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    return renderHook(() => useSignIn(), { wrapper });
  }

  it('a successful sign-in runs the transition block: purges the previous data, publishes the user, owns the cache', async () => {
    const { client, session } = setup();
    session.transition(ANONYMOUS_SESSION);
    client.setQueryData(['projects', 'list'], 'left over');
    const spy = mockFetch(() => jsonResponse(loginOk));
    const { result } = hook(client);

    await act(() => result.current.mutateAsync({ email: testUser.email, password: 'a long password' }));

    expect(session.value).toMatchObject({ status: 'authenticated', user: { id: testUser.id } });
    expect(session.owner).toBe(testUser.id);
    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      email: testUser.email,
      password: 'a long password',
    });
  });

  it('runs while the session is unknown or anonymous (the genuine marker exempts it from the gate)', async () => {
    for (const state of [{ status: 'unknown' } as const, ANONYMOUS_SESSION]) {
      const { client, session } = setup();
      session.transition(state);
      mockFetch(() => jsonResponse(loginOk));
      const { result } = hook(client);

      await act(() => result.current.mutateAsync({ email: testUser.email, password: 'a long password' }));

      expect(session.value.status).toBe('authenticated');
    }
  });

  it('invalid credentials are not a session event: they change nothing, even while another user is signed in', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('current'));
    client.setQueryData(['projects', 'list'], 'kept');
    mockFetch(() => jsonResponse(invalidCredentialsError, 401));
    const { result } = hook(client);

    await act(async () => {
      await expect(
        result.current.mutateAsync({ email: 'x@example.com', password: 'wrong' }),
      ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    });

    expect(session.value).toEqual(signedIn('current'));
    expect(client.getQueryData(['projects', 'list'])).toBe('kept');
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a failed sign-in even with the code "unauthenticated" does not end the session (authentication mutations handle themselves)', async () => {
    const { client, session, onSessionEnded } = setup();
    session.transition(signedIn('current'));
    mockFetch(unauthenticated);
    const { result } = hook(client);

    await act(async () => {
      await expect(
        result.current.mutateAsync({ email: 'x@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(ApiClientError);
    });

    expect(session.value).toEqual(signedIn('current'));
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('a sign-in clears the "deliberate sign-out" mark so a later expiry is announced', async () => {
    const { client, session } = setup();
    session.transition(signedIn());
    mockFetch(() => new Response(null, { status: 204 }));
    await signOut(client);
    expect(isDeliberateSignOut(client)).toBe(true);
    mockFetch(() => jsonResponse(loginOk));
    const { result } = hook(client);

    await act(() => result.current.mutateAsync({ email: testUser.email, password: 'a long password' }));

    expect(isDeliberateSignOut(client)).toBe(false);
  });
});
