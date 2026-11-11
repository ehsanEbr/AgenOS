import type { z } from 'zod';
import {
  CORRELATION_ID_HEADER,
  type CreateSystemJobRequest,
  apiErrorSchema,
  readinessResponseSchema,
  systemJobSchema,
} from '@agentos/contracts';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

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
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Non-2xx statuses whose body should still be parsed with the success schema. */
  acceptStatuses?: number[];
  signal?: AbortSignal;
}

/** Performs a request and validates the response against a shared contract schema. */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  { method = 'GET', body, acceptStatuses = [], signal }: RequestOptions = {},
): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
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

  if (!response.ok && !acceptStatuses.includes(response.status)) {
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

export const api = {
  /** Readiness returns 503 with a valid body when a dependency is down; that is data, not an error. */
  getReadiness: (signal?: AbortSignal) =>
    apiRequest('/health/ready', readinessResponseSchema, { acceptStatuses: [503], signal }),
  createSystemJob: (request: CreateSystemJobRequest) =>
    apiRequest('/system/jobs', systemJobSchema, { method: 'POST', body: request }),
  getSystemJob: (id: string, signal?: AbortSignal) =>
    apiRequest(`/system/jobs/${encodeURIComponent(id)}`, systemJobSchema, { signal }),
};
