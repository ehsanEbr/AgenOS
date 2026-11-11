import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api } from './client';

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
  it('treats a 503 readiness response as data', async () => {
    mockFetch(503, { status: 'degraded', checks: { database: { status: 'down' }, redis: { status: 'up' } } });
    const result = await api.getReadiness();
    expect(result.status).toBe('degraded');
  });

  it('maps the standard API error format to ApiClientError', async () => {
    mockFetch(404, { code: 'job_not_found', message: 'missing', correlationId: 'cid-1' });
    await expect(api.getSystemJob('7c9e6679-7425-40de-944b-e07fc1f90ae7')).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 404,
      code: 'job_not_found',
      correlationId: 'cid-1',
    });
  });

  it('rejects responses that violate the contract', async () => {
    mockFetch(200, { status: 'weird' });
    await expect(api.getReadiness()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports network failures as ApiClientError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await api.getReadiness().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('network_error');
  });

  it('sends JSON bodies when creating a job', async () => {
    const fn = mockFetch(202, {
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      status: 'QUEUED',
      message: 'hi',
      output: null,
      error: null,
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
    });
    await api.createSystemJob({ message: 'hi' });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/system/jobs');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"message":"hi"}');
  });
});
