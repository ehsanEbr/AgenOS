import { useMutation } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { requireSessionLifecycle } from '../../features/auth';
import { ApiClientError } from '../../shared/api/errors';
import { createTestQueryClient } from '../../test/render';
import { UI_PREFERENCES_STORAGE_KEY, useUiPreferences } from '../state/ui-preferences.store';
import { createQueryClient } from './query-client';

/** A test client with a signed-in user: private queries and mutations only run while the session is authenticated (ADR-0012 D4). */
function signedInTestClient() {
  const client = createTestQueryClient();
  requireSessionLifecycle(client).transition({
    status: 'authenticated',
    user: { id: 'u1', email: 'u1@example.com', displayName: 'U One' },
  });
  return client;
}

const http = (status: number) => new ApiClientError({ kind: 'http', message: 'x', status, code: 'c' });
const network = () => new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' });

describe('query client defaults', () => {
  it('keeps data fresh for 30 s and never retries mutations', () => {
    const options = createQueryClient().getDefaultOptions();
    expect(options.queries?.staleTime).toBe(30_000);
    expect(options.mutations?.retry).toBe(false);
  });
});

describe('query retry policy (real policy, instant backoff)', () => {
  it('does not retry a client error: one call, then the error', async () => {
    const queryFn = vi.fn().mockRejectedValue(http(404));
    await expect(signedInTestClient().fetchQuery({ queryKey: ['a'], queryFn })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('retries a temporary outage and recovers', async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(http(503)).mockResolvedValue('ok');
    await expect(signedInTestClient().fetchQuery({ queryKey: ['b'], queryFn })).resolves.toBe('ok');
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries when the network stays down', async () => {
    const queryFn = vi.fn().mockRejectedValue(network());
    await expect(signedInTestClient().fetchQuery({ queryKey: ['c'], queryFn })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(queryFn).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it('never retries a cancellation', async () => {
    const queryFn = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(signedInTestClient().fetchQuery({ queryKey: ['d'], queryFn })).rejects.toBeInstanceOf(
      DOMException,
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('never retries a mutation, even for a recoverable error', async () => {
    const client = signedInTestClient();
    const mutationFn = vi.fn().mockRejectedValue(network());
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useMutation({ mutationFn }), { wrapper });

    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe('the end of a session (ADR-0012 D4 rule 5 step 4)', () => {
  const ORGANIZATION = '3f2c9a1e-5b7d-4c80-9e14-6a2d8b0c7f55';
  const user = {
    status: 'authenticated',
    user: { id: 'u1', email: 'u1@example.com', displayName: 'U One' },
  } as const;

  it('forgets the last-used organization when the session becomes anonymous, with no callback supplied', () => {
    const client = createQueryClient();
    requireSessionLifecycle(client).transition(user);
    useUiPreferences.getState().setLastOrganizationId(ORGANIZATION);

    requireSessionLifecycle(client).transition({ status: 'anonymous' });

    expect(useUiPreferences.getState().lastOrganizationId).toBeNull();
  });

  it('runs the supplied callback as well, after forgetting it', () => {
    const order: string[] = [];
    const client = createQueryClient({
      onSessionEnded: () =>
        order.push(`callback sees ${String(useUiPreferences.getState().lastOrganizationId)}`),
    });
    requireSessionLifecycle(client).transition(user);
    useUiPreferences.getState().setLastOrganizationId(ORGANIZATION);

    requireSessionLifecycle(client).transition({ status: 'anonymous' });

    expect(order).toEqual(['callback sees null']);
  });

  it('keeps the chosen language and the other browser preferences: only the last-used organization is forgotten', () => {
    const client = createQueryClient();
    requireSessionLifecycle(client).transition(user);
    useUiPreferences.getState().setLocale('fa');
    useUiPreferences.getState().setThemeMode('dark');
    useUiPreferences.getState().setSidebarCollapsed(true);
    useUiPreferences.getState().setLastOrganizationId(ORGANIZATION);

    requireSessionLifecycle(client).transition({ status: 'anonymous' });

    expect(useUiPreferences.getState()).toMatchObject({
      locale: 'fa',
      themeMode: 'dark',
      sidebarCollapsed: true,
      lastOrganizationId: null,
    });
    const saved = JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(saved.state).toMatchObject({ locale: 'fa', themeMode: 'dark', sidebarCollapsed: true });
  });

  it.each([
    ['authenticated', user],
    ['unknown', { status: 'unknown' } as const],
  ])('leaves it alone when the session becomes %s', (_, next) => {
    const client = createQueryClient();
    requireSessionLifecycle(client).transition(user);
    useUiPreferences.getState().setLastOrganizationId(ORGANIZATION);

    requireSessionLifecycle(client).transition(next);

    expect(useUiPreferences.getState().lastOrganizationId).toBe(ORGANIZATION);
  });
});
