import { useMutation } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../shared/api/errors';
import { createTestQueryClient } from '../../test/render';
import { createQueryClient } from './query-client';

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
    await expect(createTestQueryClient().fetchQuery({ queryKey: ['a'], queryFn })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('retries a temporary outage and recovers', async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(http(503)).mockResolvedValue('ok');
    await expect(createTestQueryClient().fetchQuery({ queryKey: ['b'], queryFn })).resolves.toBe('ok');
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries when the network stays down', async () => {
    const queryFn = vi.fn().mockRejectedValue(network());
    await expect(createTestQueryClient().fetchQuery({ queryKey: ['c'], queryFn })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(queryFn).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it('never retries a cancellation', async () => {
    const queryFn = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(createTestQueryClient().fetchQuery({ queryKey: ['d'], queryFn })).rejects.toBeInstanceOf(
      DOMException,
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('never retries a mutation, even for a recoverable error', async () => {
    const client = createTestQueryClient();
    const mutationFn = vi.fn().mockRejectedValue(network());
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useMutation({ mutationFn }), { wrapper });

    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});
