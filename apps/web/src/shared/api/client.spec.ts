import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { healthResponseSchema } from '@agentos/contracts';
import {
  healthOk,
  htmlResponse,
  jsonResponse,
  mockFetch,
  notFoundError,
  validationError,
} from '../../test/fixtures/api';
import { apiRequest, createCorrelationId } from './client';
import { ApiClientError, isApiClientError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (error: unknown) => error,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('apiRequest: success', () => {
  it('returns data validated and typed by the shared contract', async () => {
    mockFetch(() => jsonResponse(healthOk));
    await expect(apiRequest('/health', healthResponseSchema)).resolves.toEqual(healthOk);
  });

  it('calls the configured base URL and never hardcodes a host', async () => {
    const fetchSpy = mockFetch(() => jsonResponse(healthOk));
    await apiRequest('/health', healthResponseSchema);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/health');
  });

  it('sends a fresh correlation id with every request', async () => {
    const fetchSpy = mockFetch(() => jsonResponse(healthOk));
    await apiRequest('/health', healthResponseSchema);
    await apiRequest('/health', healthResponseSchema);

    const ids = fetchSpy.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['x-correlation-id'],
    );
    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toMatch(UUID);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('serializes JSON bodies and sets the content type only when there is a body', async () => {
    const fetchSpy = mockFetch(() => jsonResponse({ ok: true }));
    await apiRequest('/things', z.object({ ok: z.boolean() }), { method: 'POST', body: { name: 'x' } });
    await apiRequest('/health', healthResponseSchema.or(z.object({ ok: z.boolean() })));

    const [, post] = fetchSpy.mock.calls[0]!;
    expect(post?.method).toBe('POST');
    expect(post?.body).toBe('{"name":"x"}');
    expect((post?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect((fetchSpy.mock.calls[1]![1]?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('builds query strings following the API conventions: skips empty values, repeats array keys', async () => {
    const fetchSpy = mockFetch(() => jsonResponse({}));
    await apiRequest('/agents', z.object({}), {
      query: {
        limit: 20,
        offset: 0,
        sort: '-createdAt',
        status: ['running', 'queued'],
        search: undefined,
        owner: null,
        archived: false,
      },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      '/api/v1/agents?limit=20&offset=0&sort=-createdAt&status=running&status=queued&archived=false',
    );
  });

  it('accepts an empty body when the contract expects none (204)', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(apiRequest('/things/1', z.undefined(), { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('apiRequest: failures are normalized to ApiClientError', () => {
  it('maps the API error body, keeping code, details and the server correlation id', async () => {
    mockFetch(() => jsonResponse(notFoundError, 404));
    const error = await failureOf(apiRequest('/agents/1', healthResponseSchema));

    expect(isApiClientError(error)).toBe(true);
    expect(error).toMatchObject({
      kind: 'http',
      status: 404,
      code: 'agent_not_found',
      correlationId: 'srv-8b1f2c',
    });
  });

  it('keeps validation details for the caller', async () => {
    mockFetch(() => jsonResponse(validationError, 400));
    const error = (await failureOf(apiRequest('/agents', healthResponseSchema))) as ApiClientError;
    expect(error.code).toBe('validation_error');
    expect(error.details).toEqual(validationError.details);
  });

  it('survives a non-JSON error page from a proxy and still reports a correlation id', async () => {
    mockFetch(() => htmlResponse(502));
    const error = (await failureOf(apiRequest('/health', healthResponseSchema))) as ApiClientError;
    expect(error).toMatchObject({ kind: 'http', status: 502, code: 'unknown_error' });
    expect(error.correlationId).toMatch(UUID); // falls back to the id we sent
  });

  it('rejects a 2xx response that violates the contract', async () => {
    mockFetch(() => jsonResponse({ status: 'weird' }));
    const error = await failureOf(apiRequest('/health', healthResponseSchema));
    expect(error).toMatchObject({ kind: 'invalid_response', code: 'invalid_response' });
  });

  it('reports a network failure without leaking the underlying error', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch: net::ERR_CONNECTION_REFUSED 10.0.0.5')));
    const error = (await failureOf(apiRequest('/health', healthResponseSchema))) as ApiClientError;
    expect(error).toMatchObject({ kind: 'network', code: 'network_error', status: 0 });
    expect(error.message).not.toContain('10.0.0.5');
    expect(error.correlationId).toMatch(UUID);
  });

  it('times out slow requests as a distinct, retryable kind', async () => {
    mockFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const error = await failureOf(apiRequest('/health', healthResponseSchema, { timeoutMs: 25 }));
    expect(error).toMatchObject({ kind: 'timeout', code: 'timeout' });
  });
});

describe('apiRequest: cancellation', () => {
  function hangingFetch() {
    return mockFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
  }

  it('rethrows an AbortError (not an ApiClientError) when the caller cancels', async () => {
    hangingFetch();
    const controller = new AbortController();
    const pending = failureOf(apiRequest('/health', healthResponseSchema, { signal: controller.signal }));
    controller.abort();

    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('does not even start a request that was already cancelled', async () => {
    const fetchSpy = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(apiRequest('/health', healthResponseSchema, { signal: controller.signal }));
    expect((error as DOMException).name).toBe('AbortError');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createCorrelationId', () => {
  it('produces a v4 UUID even where crypto.randomUUID is unavailable (plain-HTTP origins)', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(createCorrelationId()).toMatch(UUID);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
