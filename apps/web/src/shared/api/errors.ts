/**
 * Error model of the API client. Everything that can go wrong with a request is normalized to ONE class, so UI
 * code never inspects `fetch`/DOM errors or raw response bodies.
 *
 *  - network           the request never produced a response (offline, DNS, CORS, API down)
 *  - timeout           no response within the configured time
 *  - http              the API answered with an error status (usually the standard ApiError body)
 *  - invalid_response  the API answered 2xx but the body does not match the shared contract
 *
 * A request cancelled on purpose (AbortSignal) is NOT an ApiClientError: it is rethrown as the browser's AbortError
 * so TanStack Query can ignore it.
 */
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid_response';

export interface ApiClientErrorInit {
  kind: ApiErrorKind;
  /** Developer-facing English text (logs, tests). UI shows localized text derived from the category instead. */
  message: string;
  /** HTTP status, or 0 when there was no response. */
  status?: number;
  /** Stable API error code (`validation_error`, `agent_not_found`, ...) or a client-side code (`network_error`). */
  code: string;
  /** Correlates this failure with server logs: from the response when present, otherwise the id we sent. */
  correlationId?: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly details?: unknown;

  constructor(init: ApiClientErrorInit) {
    super(init.message);
    this.name = 'ApiClientError';
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.code = init.code;
    this.correlationId = init.correlationId;
    this.details = init.details;
  }
}

export const isApiClientError = (error: unknown): error is ApiClientError => error instanceof ApiClientError;

/** True for a deliberate cancellation (`AbortController.abort()`), which is not a failure to report. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Presentation categories. The UI maps a category to a localized message (`common:errors.<category>`), so backend
 * wording and status codes never reach components.
 */
export type ErrorCategory =
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'server'
  | 'unknown';

export function categorizeError(error: unknown): ErrorCategory {
  if (!isApiClientError(error)) return 'unknown';
  if (error.kind === 'network') return 'network';
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'invalid_response') return 'invalid_response';

  switch (error.status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'unavailable';
    default:
      return error.status >= 500 ? 'server' : 'unknown';
  }
}

/**
 * Recoverable failures: the same request may succeed a moment later. Client mistakes (4xx), contract violations
 * and cancellations are never retried: repeating them cannot help and only adds load.
 */
export function isRetryableError(error: unknown): boolean {
  if (!isApiClientError(error)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  return error.kind === 'http' && [408, 502, 503, 504].includes(error.status);
}

export const MAX_RETRIES = 2;

/** Retry policy for TanStack Query: at most `MAX_RETRIES` retries, and only for recoverable failures. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && isRetryableError(error);
}

/** Exponential backoff with a ceiling: 1 s, 2 s, 4 s, ... up to 8 s. */
export function retryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000);
}
