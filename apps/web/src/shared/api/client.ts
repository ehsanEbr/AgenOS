import type { z } from 'zod';
import { CORRELATION_ID_HEADER, apiErrorSchema, healthResponseSchema } from '@agentos/contracts';
import { env } from '../config/env';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly correlationId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * The single entry point for HTTP calls. Responses are validated against a shared contract
 * schema, and failures are normalized to `ApiClientError` (including the API's standard error body).
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiClientError('Cannot reach the AgentOS API', 0, 'network_error');
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      const e = parsed.data;
      throw new ApiClientError(e.message, response.status, e.code, e.correlationId, e.details);
    }
    throw new ApiClientError(
      `Request failed with status ${response.status}`,
      response.status,
      'unknown_error',
      response.headers.get(CORRELATION_ID_HEADER) ?? undefined,
    );
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiClientError('The API returned an unexpected response', response.status, 'invalid_response');
  }
  return result.data;
}

/** Endpoint functions grouped here until feature APIs outgrow a single file. */
export const api = {
  getHealth: (signal?: AbortSignal) => apiRequest('/health', healthResponseSchema, { signal }),
};
