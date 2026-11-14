import { vi } from 'vitest';
import type { ApiError, HealthResponse } from '@agentos/contracts';

/*
 * Realistic API payloads. They are typed with the shared contracts, so a contract change breaks the fixture at compile time
 * instead of leaving tests that quietly pass on obsolete shapes.
 */

export const healthOk = {
  status: 'ok',
  service: 'api',
  uptimeSeconds: 3_721,
} satisfies HealthResponse;

export const notFoundError = {
  code: 'agent_not_found',
  message: 'Agent 5f0d6c1e was not found',
  correlationId: 'srv-8b1f2c',
} satisfies ApiError;

export const validationError = {
  code: 'validation_error',
  message: 'Request validation failed',
  details: [{ path: 'limit', message: 'Too big: expected number to be <=100' }],
  correlationId: 'srv-41aa09',
} satisfies ApiError;

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const htmlResponse = (status: number) =>
  new Response('<html><body>Bad gateway</body></html>', { status, headers: { 'content-type': 'text/html' } });

type Handler = (request: { url: URL; init: RequestInit }) => Response | Promise<Response>;

/**
 * Replaces `fetch` with a controllable fake and returns the spy for assertions. The handler receives the parsed URL
 * (relative URLs resolve against http://localhost), so tests can route by pathname.
 */
export function mockFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    handler({ url: new URL(String(input), 'http://localhost'), init }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The health endpoint answers OK and everything else is a 404 in the API's standard error format. */
export const healthyApi = () =>
  mockFetch(({ url }) =>
    url.pathname.endsWith('/health') ? jsonResponse(healthOk) : jsonResponse(notFoundError, 404),
  );
