/**
 * Application errors: failures that are EXPECTED parts of the program's behavior (a record does not exist, a
 * rule forbids the action, input is invalid). They carry a stable machine-readable `code` and a safe, human-readable
 * `message`, and are the only error type domain and application code should throw on purpose.
 *
 * This file deliberately has no framework imports so the domain layer can use it. The HTTP status comes from `kind`
 * and is applied by the global exception filter; anything that is NOT an AppError (or an HttpException) is treated as
 * an unexpected internal error: it is logged with its stack and answered with a generic 500.
 */
export type AppErrorKind =
  | 'validation' // 400 - input is malformed or violates a schema
  | 'unauthenticated' // 401 - caller identity unknown
  | 'forbidden' // 403 - caller known but not allowed
  | 'not_found' // 404 - target does not exist (or must not be revealed)
  | 'conflict' // 409 - state conflict, e.g. unique constraint, concurrent modification
  | 'unprocessable' // 422 - input is well-formed but a business rule rejects it
  | 'rate_limited' // 429
  | 'unavailable'; // 503 - a required dependency is temporarily unavailable; retrying may succeed

export const HTTP_STATUS_BY_ERROR_KIND: Readonly<Record<AppErrorKind, number>> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  unavailable: 503,
};

export class AppError extends Error {
  constructor(
    readonly kind: AppErrorKind,
    /** Stable snake_case identifier clients can switch on, e.g. `agent_not_found`. Never reuse a code for a different meaning. */
    readonly code: string,
    /** Safe to show to API clients: no stack traces, SQL, hostnames, secrets or internal identifiers. */
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.details = options.details;
  }

  /** Optional structured, client-safe detail (for example per-field validation issues). */
  readonly details?: unknown;
}
