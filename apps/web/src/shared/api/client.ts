import type { z } from 'zod';
import { CORRELATION_ID_HEADER, apiErrorSchema } from '@agentos/contracts';
import { env } from '../config/env';
import { ApiClientError } from './errors';

export type QueryParamValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Query-string parameters. `undefined`/`null` are skipped; arrays repeat the key (`?status=a&status=b`), which is
   * the API's "any of" filter convention. Pagination and sorting use the same mechanism (`limit`, `offset`, `sort`).
   */
  query?: Record<string, QueryParamValue | readonly QueryParamValue[]>;
  /** Cancellation. TanStack Query passes its `signal` here so unmounting a component cancels the request. */
  signal?: AbortSignal;
  /** Overrides the default timeout (`VITE_API_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * Correlation id sent with every request (`x-correlation-id`) so a failure in the browser can be matched to API logs.
 * `crypto.randomUUID` only exists in secure contexts (HTTPS/localhost); the fallback keeps plain-HTTP LAN setups working.
 */
export function createCorrelationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) params.append(key, String(item));
    }
  }
  const search = params.toString();
  return `${env.apiBaseUrl}${path}${search ? `?${search}` : ''}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // e.g. an HTML error page from a proxy
  }
}

/**
 * The single entry point for HTTP calls to the AgentOS API. Feature code never calls `fetch` (enforced by ESLint).
 *
 *  - The response body is validated against a shared contract schema: a mismatch is an `invalid_response` error,
 *    so components can trust the types they receive.
 *  - Failures are normalized to `ApiClientError` (see errors.ts); deliberate cancellation is rethrown as AbortError.
 *  - Every request has a timeout and a correlation id.
 *  - The base URL and timeout come from the validated environment, never from call sites.
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  { method = 'GET', body, query, signal, timeoutMs = env.apiTimeoutMs }: RequestOptions = {},
): Promise<z.output<S>> {
  // A request cancelled before it starts never reaches the network.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const correlationId = createCorrelationId();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      signal: combined,
      headers: {
        accept: 'application/json',
        [CORRELATION_ID_HEADER]: correlationId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (signal?.aborted)
      throw cause instanceof DOMException ? cause : new DOMException('Aborted', 'AbortError');
    if (timeout.aborted) {
      throw new ApiClientError({
        kind: 'timeout',
        message: `The API did not respond within ${timeoutMs} ms`,
        code: 'timeout',
        correlationId,
      });
    }
    throw new ApiClientError({
      kind: 'network',
      message: 'Cannot reach the AgentOS API',
      code: 'network_error',
      correlationId,
    });
  }

  const responseCorrelationId = response.headers.get(CORRELATION_ID_HEADER) ?? correlationId;
  const payload = await readBody(response);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiClientError({
        kind: 'http',
        message: parsed.data.message,
        status: response.status,
        code: parsed.data.code,
        correlationId: parsed.data.correlationId,
        details: parsed.data.details,
      });
    }
    throw new ApiClientError({
      kind: 'http',
      message: `Request failed with status ${response.status}`,
      status: response.status,
      code: 'unknown_error',
      correlationId: responseCorrelationId,
    });
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiClientError({
      kind: 'invalid_response',
      message: 'The API returned a response that does not match its contract',
      status: response.status,
      code: 'invalid_response',
      correlationId: responseCorrelationId,
    });
  }
  return result.data;
}
