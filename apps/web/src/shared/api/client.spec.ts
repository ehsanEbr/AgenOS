import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api, apiRequest } from './client';
import { z } from 'zod';

function mockFetch(status: number, body: unknown) {
  const fn = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('returns validated data from the shared contract', async () => {
    const fn = mockFetch(200, { status: 'ok', service: 'api', uptimeSeconds: 3 });
    await expect(api.getHealth()).resolves.toEqual({ status: 'ok', service: 'api', uptimeSeconds: 3 });
    expect(fn.mock.calls[0]?.[0]).toBe('/api/v1/health');
  });

  it('maps the standard API error format to ApiClientError', async () => {
    mockFetch(404, { code: 'thing_missing', message: 'missing', correlationId: 'cid-1' });
    await expect(api.getHealth()).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 404,
      code: 'thing_missing',
      correlationId: 'cid-1',
    });
  });

  it('rejects responses that violate the contract', async () => {
    mockFetch(200, { status: 'weird' });
    await expect(api.getHealth()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports network failures as ApiClientError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('network_error');
  });

  it('sends JSON bodies', async () => {
    const fn = mockFetch(200, { ok: true });
    await apiRequest('/things', z.object({ ok: z.boolean() }), { method: 'POST', body: { name: 'x' } });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x"}');
  });
});
