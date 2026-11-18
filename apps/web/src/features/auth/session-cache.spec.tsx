import { QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/providers/query-client';
import { jsonResponse, meOk, mockFetch, testUser, unauthenticatedError } from '../../test/fixtures/api';
import { ANONYMOUS_SESSION, SESSION_KEY, type SessionValue } from './session';
import { SessionLifecycle, requireSessionLifecycle } from './session-lifecycle';
import { sessionQueryOptions } from './session-probe';

/*
 * Two properties of how the session lives in the TanStack Query cache (Step 2 audit findings):
 *   1. the `['session']` entry is never garbage-collected;
 *   2. a probe result cannot overwrite a newer session transition when TanStack Query stores it.
 * (Credentials and the mutation cache: `credential-mutation.spec.tsx`.)
 */

const signedIn = (id: string): SessionValue => ({
  status: 'authenticated',
  user: { id, email: `${id}@example.com`, displayName: id },
});

function setup() {
  const onSessionEnded = vi.fn();
  const client = createQueryClient({ onSessionEnded });
  return { client, session: requireSessionLifecycle(client), onSessionEnded };
}

const nextTimer = () => new Promise<void>((done) => setTimeout(done, 0));

describe('the session entry is never garbage-collected (ADR-0012 D4 rule 2)', () => {
  afterEach(() => vi.useRealTimers());
  const TEN_MINUTES = 10 * 60_000;

  it('an entry written by a transition with no observer at all survives well past the default gcTime', () => {
    vi.useFakeTimers();
    const { client, session } = setup();
    session.transition(signedIn('a'));

    vi.advanceTimersByTime(TEN_MINUTES);

    expect(client.getQueryData(SESSION_KEY)).toEqual(signedIn('a'));
    expect(session.value).toEqual(signedIn('a'));
    expect(session.owner).toBe('a');
  });

  it('it survives after every observer has gone, so the lifecycle owner never outlives its session value', () => {
    vi.useFakeTimers();
    const { client, session } = setup();
    session.transition(signedIn('a'));
    const observer = new QueryObserver(client, {
      ...sessionQueryOptions(client),
      queryFn: async () => signedIn('a'),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    unsubscribe();

    vi.advanceTimersByTime(TEN_MINUTES);

    expect(session.value).toEqual(signedIn('a'));
    expect(session.owner).toBe('a');
  });

  it('every later state is kept the same way (anonymous, unknown)', () => {
    vi.useFakeTimers();
    const { client, session } = setup();
    session.transition(signedIn('a'));
    session.transition(ANONYMOUS_SESSION);
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(client.getQueryData(SESSION_KEY)).toEqual(ANONYMOUS_SESSION);
  });

  it('private queries are unaffected: an unobserved private entry is still collected after the normal interval', () => {
    vi.useFakeTimers();
    const { client } = setup();
    client.setQueryData(['projects', 'list'], 'private');

    vi.advanceTimersByTime(4 * 60_000);
    expect(client.getQueryData(['projects', 'list'])).toBe('private');
    vi.advanceTimersByTime(2 * 60_000);
    expect(client.getQueryData(['projects', 'list'])).toBeUndefined();
  });
});

describe('a probe result cannot overwrite a newer transition when TanStack Query stores it', () => {
  /**
   * The ordering, made deterministic. The probe publishes through the lifecycle and returns; TanStack Query stores the returned
   * value a microtask later (`Promise.resolve(result).then(store)` in its retryer). A microtask that is already queued when the
   * probe returns runs BEFORE that store. Here it is a competing transition, queued right after the probe's own publication.
   */
  function raceAfterProbePublishes(
    session: ReturnType<typeof requireSessionLifecycle>,
    competing: SessionValue,
  ) {
    const original = session.transition.bind(session);
    let queued = false;
    vi.spyOn(session, 'transition').mockImplementation((next) => {
      original(next);
      if (!queued && next.status === 'authenticated') {
        queued = true;
        queueMicrotask(() => original(competing));
      }
    });
  }

  it('the cache keeps the newer anonymous session, and the lifecycle state is consistent with it', async () => {
    const { client, session, onSessionEnded } = setup();
    mockFetch(() => jsonResponse(meOk));
    raceAfterProbePublishes(session, ANONYMOUS_SESSION);

    await client.fetchQuery(sessionQueryOptions(client));

    expect(client.getQueryData(SESSION_KEY)).toEqual(ANONYMOUS_SESSION); // not the probe's older "authenticated"
    expect(session.owner).toBeNull();
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('the same holds for a probe that was DISCARDED: the current value it hands back must not overwrite a newer one either', async () => {
    const { client, session } = setup();
    let answer!: (response: Response) => void;
    mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    const fetching = client.fetchQuery(sessionQueryOptions(client)); // the probe starts in generation 0
    await nextTimer();

    session.transition(signedIn('signed-in-meanwhile')); // a sign-in finishes first: the probe will be discarded

    // The probe, once answered, hands back the CURRENT value. Right then (when it reads it), a newer transition is queued as a
    // microtask: it runs before TanStack Query stores what the probe returned.
    const readCurrentValue = Object.getOwnPropertyDescriptor(SessionLifecycle.prototype, 'value')!.get!.bind(
      session,
    );
    let armed = true;
    vi.spyOn(session, 'value', 'get').mockImplementation(() => {
      const current = readCurrentValue();
      if (armed) {
        armed = false;
        queueMicrotask(() => session.transition(ANONYMOUS_SESSION));
      }
      return current;
    });
    answer(jsonResponse(meOk));
    await fetching;

    expect(client.getQueryData(SESSION_KEY)).toEqual(ANONYMOUS_SESSION); // not the "signed-in-meanwhile" the probe handed back
    expect(session.owner).toBeNull();
  });

  it('the same holds when the newer transition is another user signing in', async () => {
    const { client, session } = setup();
    mockFetch(() => jsonResponse(meOk));
    raceAfterProbePublishes(session, signedIn('someone-else'));

    await client.fetchQuery(sessionQueryOptions(client));

    expect(client.getQueryData(SESSION_KEY)).toEqual(signedIn('someone-else'));
    expect(session.owner).toBe('someone-else');
  });

  it('a probe with no competing transition stores its own result (the guard is not a blanket refusal)', async () => {
    const { client, session } = setup();
    mockFetch(() => jsonResponse(meOk));

    await client.fetchQuery(sessionQueryOptions(client));

    expect(client.getQueryData(SESSION_KEY)).toMatchObject({
      status: 'authenticated',
      user: { id: testUser.id },
    });
    expect(session.owner).toBe(testUser.id);
  });

  it('a probe that answered "anonymous" does not poison the shared anonymous value: a later publication of it is still stored', async () => {
    const { client, session } = setup();
    mockFetch(() => jsonResponse(unauthenticatedError, 401));
    await client.fetchQuery(sessionQueryOptions(client)); // the probe returned a tagged copy of the anonymous state

    session.transition(signedIn('a'));
    session.transition(ANONYMOUS_SESSION); // a later generation publishes the SAME shared constant

    expect(client.getQueryData(SESSION_KEY)).toEqual(ANONYMOUS_SESSION);
    expect(session.value.status).toBe('anonymous');
  });

  it('a later, legitimate transition is never blocked by an earlier probe result (publications carry no tag)', async () => {
    const { client, session } = setup();
    mockFetch(() => jsonResponse(meOk));
    await client.fetchQuery(sessionQueryOptions(client));

    session.transition(signedIn('second'));
    session.transition(ANONYMOUS_SESSION);
    session.transition(signedIn(testUser.id));

    expect(client.getQueryData(SESSION_KEY)).toEqual(signedIn(testUser.id));
    expect(session.owner).toBe(testUser.id);
  });
});
