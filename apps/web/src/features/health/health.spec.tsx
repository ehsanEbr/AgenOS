import { renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { healthOk, jsonResponse, mockFetch, notFoundError } from '../../test/fixtures/api';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { ApiStatus } from './ApiStatus';
import { useApiHealth } from './queries';

function hookWrapper() {
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useApiHealth', () => {
  it('returns the contract-typed liveness payload', async () => {
    mockFetch(() => jsonResponse(healthOk));
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => useApiHealth(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(healthOk);
  });

  it('recovers from a temporary outage (503) by retrying', async () => {
    let calls = 0;
    const fetchSpy = mockFetch(() =>
      ++calls === 1
        ? jsonResponse({ code: 'database_unavailable', message: 'x', correlationId: 'c' }, 503)
        : jsonResponse(healthOk),
    );
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => useApiHealth(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error', async () => {
    const fetchSpy = mockFetch(() => jsonResponse(notFoundError, 404));
    const { wrapper } = hookWrapper();
    const { result } = renderHook(() => useApiHealth(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the in-flight request when the component unmounts', async () => {
    let signal: AbortSignal | null | undefined;
    mockFetch(({ init }) => {
      signal = init.signal;
      return new Promise<Response>(() => undefined); // never answers
    });
    const { wrapper } = hookWrapper();
    const { unmount } = renderHook(() => useApiHealth(), { wrapper });

    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

describe('ApiStatus', () => {
  it('goes from checking to online', async () => {
    mockFetch(() => jsonResponse(healthOk));
    renderWithProviders(<ApiStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('API: checking');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('API: online'));
  });

  it('reports unreachable once the retries are exhausted', async () => {
    const fetchSpy = mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderWithProviders(<ApiStatus />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('API: unreachable'));
    expect(fetchSpy).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });
});
