import { QueryClientProvider, onlineManager, useMutation } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/providers/query-client';
import { ApiClientError } from '../../shared/api/errors';
import { invalidCredentialsError, jsonResponse, loginOk, mockFetch, testUser } from '../../test/fixtures/api';
import { asAuthMutation } from './auth-mutation';
import {
  CREDENTIAL_OPERATION_IN_PROGRESS,
  CredentialOperationInProgressError,
  pendingCredentialHandoffs,
  releaseFlight,
  type CredentialFlight,
} from './credential-mutation';
import { useSignIn, useSignUp } from './use-session';

/*
 * Credentials and the TanStack mutation cache (ADR-0012 security considerations: nothing secret is stored by the app).
 *
 * A mutation's `variables` live in `Mutation.state.variables` for as long as the mutation is in the cache (5 minutes by default),
 * and a paused mutation holds them until it runs. So the password is never passed as a variable: the variable is an opaque token, the
 * credentials wait in a private one-shot holder, and the mutation function takes them out (and deletes them) before it builds the
 * request. These tests look at the real mutation cache and at the holder, not at what a component renders.
 */

const PASSWORD = 'correct horse battery staple 42';
const OTHER_PASSWORD = 'a completely different passphrase 77';

const operations = [
  {
    name: 'sign-in',
    path: '/auth/login',
    useHook: useSignIn,
    credentials: { email: testUser.email, password: PASSWORD },
    otherCredentials: { email: 'someone.else@example.com', password: OTHER_PASSWORD },
    success: () => jsonResponse(loginOk),
    failure: () => jsonResponse(invalidCredentialsError, 401),
    failureMatch: { status: 401, code: 'invalid_credentials' },
    result: (value: unknown) => expect(value).toMatchObject({ id: testUser.id }),
  },
  {
    name: 'sign-up',
    path: '/auth/register',
    useHook: useSignUp,
    credentials: { email: 'new@example.com', displayName: 'New User', password: PASSWORD },
    otherCredentials: { email: 'second.person@example.com', displayName: 'Second', password: OTHER_PASSWORD },
    success: () => jsonResponse({ user: testUser }, 201),
    failure: () => jsonResponse({ code: 'email_taken', message: 'x', correlationId: 'c' }, 409),
    failureMatch: { status: 409, code: 'email_taken' },
    result: (value: unknown) => expect(value).toMatchObject({ user: { id: testUser.id } }),
  },
] as const;

type Client = ReturnType<typeof createQueryClient>;
type Hook = () => { isPending: boolean; mutateAsync: (credentials: never) => Promise<unknown> };

const providers =
  (client: Client) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

const tick = () => new Promise<void>((done) => setTimeout(done, 0));
const flushMicrotasks = () => act(async () => void (await Promise.resolve()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/**
 * Every state of every mutation of the cache, from the moment it is added: the variables as JSON, and whether it is paused.
 * (Every cache event carries its mutation; `updated` is one per state change.)
 */
function watchMutations(client: Client) {
  const seen: { event: string; variables: string; isPaused: boolean }[] = [];
  client.getMutationCache().subscribe((event) => {
    const mutation = event.mutation; // an observer-options event may not carry one
    if (!mutation) return;
    seen.push({
      event: event.type,
      variables: JSON.stringify(mutation.state.variables ?? null),
      isPaused: mutation.state.isPaused,
    });
  });
  return seen;
}

const variablesInCache = (client: Client) =>
  client
    .getMutationCache()
    .getAll()
    .map((mutation) => JSON.stringify(mutation.state.variables ?? null));

afterEach(() => onlineManager.setOnline(true));

describe('why a token and not the password', () => {
  it('control: an ordinary TanStack mutation keeps its variables (the password) in the mutation cache after it settles', async () => {
    const client = createQueryClient();
    const { result } = renderHook(
      () => useMutation(asAuthMutation({ mutationFn: async (_: { password: string }) => 'ok' })),
      { wrapper: providers(client) },
    );

    await act(() => result.current.mutateAsync({ password: PASSWORD }));
    await act(tick);

    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(true);
  });
});

describe.each(operations)('$name: the credentials never enter the mutation cache', (operation) => {
  const hook = (client: Client) => renderHook(operation.useHook as Hook, { wrapper: providers(client) });
  const call = (result: { current: ReturnType<Hook> }) =>
    result.current.mutateAsync(operation.credentials as never);

  it('the password is absent from Mutation.state.variables in every state, from the moment the mutation is created (success)', async () => {
    const client = createQueryClient();
    const seen = watchMutations(client);
    const spy = mockFetch(operation.success);
    const { result } = hook(client);

    await act(async () => operation.result(await call(result)));
    await act(tick);

    expect(seen.length).toBeGreaterThanOrEqual(3); // added, pending, success: the watch really observed the mutation
    expect(seen.every((snapshot) => !snapshot.variables.includes(PASSWORD))).toBe(true);
    expect(JSON.stringify(spy.mock.calls[0]?.[1]?.body)).toContain(PASSWORD.slice(0, 12)); // and the request DID carry it
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it('the same on failure, and the caller still receives the error unchanged', async () => {
    const client = createQueryClient();
    const seen = watchMutations(client);
    mockFetch(operation.failure);
    const { result } = hook(client);

    await act(async () => {
      await expect(call(result)).rejects.toMatchObject(operation.failureMatch);
    });
    await act(tick);

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((snapshot) => !snapshot.variables.includes(PASSWORD))).toBe(true);
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it('the holder is emptied BEFORE the request is built: it is already empty when fetch is called', async () => {
    const client = createQueryClient();
    const holderWhenSent: number[] = [];
    mockFetch(() => {
      holderWhenSent.push(pendingCredentialHandoffs());
      return operation.success();
    });
    const { result } = hook(client);

    let settled!: Promise<unknown>;
    act(() => {
      settled = call(result);
    });
    expect(pendingCredentialHandoffs()).toBe(1); // handed over, waiting for the mutation function to take it
    await act(async () => void (await settled));

    expect(holderWhenSent).toEqual([0]);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it('the holder entry is cleaned up when the request is never sent (the mutation fails before its function runs)', async () => {
    const client = createQueryClient();
    const spy = mockFetch(operation.success);
    const cache = client.getMutationCache();
    cache.config.onMutate = () => {
      throw new Error('refused before the request');
    };
    const { result } = hook(client);

    await act(async () => {
      await expect(call(result)).rejects.toThrow('refused before the request');
    });

    expect(spy).not.toHaveBeenCalled();
    expect(pendingCredentialHandoffs()).toBe(0);
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
  });

  it('offline: the mutation function runs at once (never paused), the browser fails the request, and nothing is retained', async () => {
    const client = createQueryClient();
    const seen = watchMutations(client);
    onlineManager.setOnline(false);
    const spy = mockFetch(() => {
      throw new TypeError('Failed to fetch'); // what a browser does offline
    });
    const { result } = hook(client);

    await act(async () => {
      await expect(call(result)).rejects.toMatchObject({ kind: 'network' });
    });
    await act(tick);

    expect(onlineManager.isOnline()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1); // it was not held back waiting for connectivity
    expect(seen.some((snapshot) => snapshot.isPaused)).toBe(false);
    expect(seen.every((snapshot) => !snapshot.variables.includes(PASSWORD))).toBe(true);
    expect(pendingCredentialHandoffs()).toBe(0);
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
  });

  it('uses the normal mutation lifecycle: default gcTime (no zero-delay re-check loop), no observer reset', async () => {
    const client = createQueryClient();
    mockFetch(operation.success);
    const { result } = hook(client);

    await act(async () => void (await call(result)));
    await act(tick);

    const [mutation] = client.getMutationCache().getAll();
    expect(mutation?.gcTime).toBeGreaterThanOrEqual(60_000);
    expect(mutation?.options.networkMode).toBe('always');
    expect(Object.keys(result.current).sort()).toEqual(['isPending', 'mutateAsync']); // the public API is unchanged
  });

  it('calls in the same tick share ONE request and ONE promise', async () => {
    const client = createQueryClient();
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);
    const { result } = hook(client);

    let first!: Promise<unknown>, second!: Promise<unknown>, third!: Promise<unknown>;
    act(() => {
      first = call(result);
      second = call(result);
      third = call(result);
    });
    expect(second).toBe(first);
    expect(third).toBe(first);

    await act(async () => {
      answer.resolve(operation.success());
      await first;
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it('a settled mutation cannot affect a newer one: the next call is a fresh request that stays pending until its own answer', async () => {
    const client = createQueryClient();
    const { result } = hook(client);
    mockFetch(operation.success);
    await act(async () => void (await call(result)));

    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);
    let second!: Promise<unknown>;
    act(() => {
      second = call(result);
    });
    await act(tick);
    await act(tick);

    expect(spy).toHaveBeenCalledTimes(1); // not answered from the earlier, settled call
    expect(result.current.isPending).toBe(true); // nothing from the first call reset or detached the second
    expect(client.getMutationCache().getAll()).toHaveLength(2);

    await act(async () => {
      answer.resolve(operation.success());
      await second;
    });
    await act(tick); // TanStack Query notifies its observers on a timer
    expect(result.current.isPending).toBe(false);
  });

  const callOther = (result: { current: ReturnType<Hook> }) =>
    result.current.mutateAsync(operation.otherCredentials as never);

  /** Everything the network and the caches ever saw of the second caller's credentials. */
  const nothingOfTheOtherCaller = (client: Client, spy: ReturnType<typeof mockFetch>) => {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(OTHER_PASSWORD);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(operation.otherCredentials.email);
    expect(variablesInCache(client).some((json) => json.includes(OTHER_PASSWORD))).toBe(false);
    expect(variablesInCache(client).some((json) => json.includes(operation.otherCredentials.email))).toBe(
      false,
    );
  };

  it('a different hook instance is REJECTED explicitly while one is in flight: no result, no error, no request, nothing retained', async () => {
    const client = createQueryClient();
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);
    const first = hook(client);
    const second = hook(client);

    let firstCall!: Promise<unknown>, secondCall!: Promise<unknown>;
    act(() => {
      firstCall = call(first.result);
    });
    act(() => {
      secondCall = callOther(second.result);
    });
    expect(secondCall).not.toBe(firstCall);
    await act(async () => {
      await expect(secondCall).rejects.toBeInstanceOf(CredentialOperationInProgressError);
      await expect(secondCall).rejects.toMatchObject({
        code: CREDENTIAL_OPERATION_IN_PROGRESS,
        operation: operation.name,
      });
    });
    await flushMicrotasks();
    expect(pendingCredentialHandoffs()).toBe(0); // the first caller's entry was taken; the second one's was never made
    expect(client.getMutationCache().getAll()).toHaveLength(1);

    await act(async () => {
      answer.resolve(operation.success());
      operation.result(await firstCall); // the first caller, and only the first, gets the outcome
    });
    await act(tick);

    expect(spy).toHaveBeenCalledTimes(1);
    nothingOfTheOtherCaller(client, spy);
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it("the rejected caller never receives the first caller's ERROR either", async () => {
    const client = createQueryClient();
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);
    const first = hook(client);
    const second = hook(client);

    let firstCall!: Promise<unknown>, secondCall!: Promise<unknown>;
    act(() => {
      firstCall = call(first.result);
      secondCall = callOther(second.result);
    });
    const firstFailure = expect(firstCall).rejects.toMatchObject(operation.failureMatch);
    const secondFailure = expect(secondCall).rejects.toBeInstanceOf(CredentialOperationInProgressError);
    await act(async () => {
      answer.resolve(operation.failure());
      await Promise.all([firstFailure, secondFailure]);
    });

    expect(spy).toHaveBeenCalledTimes(1);
    nothingOfTheOtherCaller(client, spy);
  });

  it('isPending is the state of the OPERATION: true for every instance while it runs, false for every instance once it settles', async () => {
    const client = createQueryClient();
    const answer = deferred<Response>();
    mockFetch(() => answer.promise);
    const first = hook(client);
    const second = hook(client);
    expect(first.result.current.isPending).toBe(false);
    expect(second.result.current.isPending).toBe(false);

    let firstCall!: Promise<unknown>;
    act(() => {
      firstCall = call(first.result);
    });
    await act(tick);
    expect(first.result.current.isPending).toBe(true);
    expect(second.result.current.isPending).toBe(true); // it never called anything, and still knows

    await act(async () => {
      answer.resolve(operation.success());
      await firstCall;
    });
    await act(tick);
    expect(first.result.current.isPending).toBe(false);
    expect(second.result.current.isPending).toBe(false);
  });

  it('pending, unmount, remount: the new page sees the operation as pending at once, and a submission is rejected, not sent', async () => {
    const client = createQueryClient();
    const answer = deferred<Response>();
    const spy = mockFetch(() => answer.promise);
    const first = hook(client);

    let inFlight!: Promise<unknown>;
    act(() => {
      inFlight = call(first.result);
    });
    await flushMicrotasks();
    first.unmount(); // the user left the page

    const second = hook(client); // and came back
    expect(second.result.current.isPending).toBe(true); // from the first render: the mutation cache already has it

    let again!: Promise<unknown>;
    act(() => {
      again = callOther(second.result);
    });
    expect(again).not.toBe(inFlight);
    await act(async () => {
      await expect(again).rejects.toBeInstanceOf(CredentialOperationInProgressError);
    });

    await act(async () => {
      answer.resolve(operation.success());
      operation.result(await inFlight); // the request of the page that was left still completes normally
    });
    await act(tick);

    expect(second.result.current.isPending).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    nothingOfTheOtherCaller(client, spy);
    expect(pendingCredentialHandoffs()).toBe(0);
    expect(variablesInCache(client).some((json) => json.includes(PASSWORD))).toBe(false);
    const [mutation] = client.getMutationCache().getAll();
    expect(mutation?.gcTime).toBeGreaterThanOrEqual(60_000); // an unobserved mutation is not re-checked in a loop
  });

  it('after the flight has settled, a later request (from another instance) starts normally with its own request and result', async () => {
    const client = createQueryClient();
    const first = hook(client);
    const second = hook(client);
    mockFetch(operation.success);
    await act(async () => void (await call(first.result)));
    await act(tick);

    const spy = mockFetch(operation.success);
    await act(async () => operation.result(await callOther(second.result)));
    await act(tick);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).toContain(OTHER_PASSWORD.slice(0, 12)); // the request carries the SECOND caller's data
    expect(client.getMutationCache().getAll()).toHaveLength(2);
    expect(pendingCredentialHandoffs()).toBe(0);
    expect(variablesInCache(client).some((json) => json.includes(OTHER_PASSWORD))).toBe(false);
  });

  it('a retry made the moment a failure arrives is a NEW request (the flight is gone before the caller continues)', async () => {
    const client = createQueryClient();
    let sent = 0;
    const spy = mockFetch(() => (++sent === 1 ? operation.failure() : operation.success()));
    const { result } = hook(client);

    await act(async () => {
      const failed = call(result);
      // The retry is made in the very first continuation of the failure (a `.catch` handler, one microtask after it settles).
      const retried = new Promise<{ retry: Promise<unknown> }>((resolve) => {
        failed.catch(() => resolve({ retry: call(result) }));
      });
      const { retry } = await retried;
      expect(retry).not.toBe(failed); // not the failed promise handed back
      operation.result(await retry);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(pendingCredentialHandoffs()).toBe(0);
  });

  it('a failure while the mutation is being set up (synchronously) leaves no flight and no holder entry behind', async () => {
    const client = createQueryClient();
    const spy = mockFetch(operation.success);
    vi.spyOn(client.getMutationCache(), 'build').mockImplementationOnce(() => {
      throw new Error('setup failed');
    });
    const first = hook(client);
    const second = hook(client);

    await act(async () => {
      await expect(call(first.result)).rejects.toThrow('setup failed');
    });
    expect(spy).not.toHaveBeenCalled();
    expect(pendingCredentialHandoffs()).toBe(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);

    // Nothing is stuck: another instance is not refused, and the same instance gets a fresh request, not the failed promise.
    await act(async () => operation.result(await callOther(second.result)));
    await act(async () => operation.result(await call(first.result)));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(pendingCredentialHandoffs()).toBe(0);
  });
});

describe('a flight is released by its own call only', () => {
  const flight = (): CredentialFlight => ({ owner: {}, promise: Promise.resolve() });

  it('ending an older flight leaves a newer flight of the same operation registered', () => {
    const active = new Map<string, CredentialFlight>();
    const older = flight();
    const newer = flight();
    active.set('sign-in', newer); // the older one is already gone, a newer one took its place

    releaseFlight(active, 'sign-in', older);

    expect(active.get('sign-in')).toBe(newer);
  });

  it('ending the registered flight removes it, and only that operation', () => {
    const active = new Map<string, CredentialFlight>();
    const own = flight();
    const unrelated = flight();
    active.set('sign-in', own);
    active.set('sign-up', unrelated);

    releaseFlight(active, 'sign-in', own);

    expect(active.has('sign-in')).toBe(false);
    expect(active.get('sign-up')).toBe(unrelated);
  });
});

describe('sign-in and sign-up stay separate operations', () => {
  it('a sign-in and a sign-up in flight at the same time do not share a request', async () => {
    const client = createQueryClient();
    const spy = mockFetch(({ url }) =>
      url.pathname.endsWith('/auth/login') ? jsonResponse(loginOk) : jsonResponse({ user: testUser }, 201),
    );
    const signIn = renderHook(() => useSignIn(), { wrapper: providers(client) });
    const signUp = renderHook(() => useSignUp(), { wrapper: providers(client) });

    let a!: Promise<unknown>, b!: Promise<unknown>;
    act(() => {
      a = signIn.result.current.mutateAsync({ email: testUser.email, password: PASSWORD });
      b = signUp.result.current.mutateAsync({ email: 'n@example.com', displayName: 'N', password: PASSWORD });
    });
    expect(a).not.toBe(b);
    await act(async () => void (await Promise.all([a, b])));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(([url]) => String(url).split('/').slice(-2).join('/')).sort()).toEqual([
      'auth/login',
      'auth/register',
    ]);
  });

  it('errors are still ApiClientError instances with the server code', async () => {
    const client = createQueryClient();
    mockFetch(() => jsonResponse(invalidCredentialsError, 401));
    const { result } = renderHook(() => useSignIn(), { wrapper: providers(client) });
    await act(async () => {
      const error = await result.current
        .mutateAsync({ email: testUser.email, password: PASSWORD })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiClientError);
    });
  });
});

vi.setConfig({ testTimeout: 60_000 }); // whole-application renders on a slow runner; a real hang still fails
