import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError } from '@agentos/contracts';
import { AppError, HTTP_STATUS_BY_ERROR_KIND } from './app-error';

const DEFAULT_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessable_entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too_many_requests',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable',
};

/**
 * - `application`: an AppError thrown on purpose by domain/application code.
 * - `http`: a Nest HttpException (framework errors such as unknown routes, or presentation-layer code).
 * - `unexpected`: anything else. This is a bug or an unclassified failure.
 */
export type ErrorClass = 'application' | 'http' | 'unexpected';

export function classifyError(exception: unknown): ErrorClass {
  if (exception instanceof AppError) return 'application';
  if (exception instanceof HttpException) return 'http';
  return 'unexpected';
}

/**
 * Converts any thrown value into the standard ApiError body (spec section 7.2).
 * Unexpected errors never leak their message to the client.
 */
export function toApiError(exception: unknown, correlationId: string): { status: number; body: ApiError } {
  if (exception instanceof AppError) {
    return {
      status: HTTP_STATUS_BY_ERROR_KIND[exception.kind],
      body: {
        code: exception.code,
        message: exception.message,
        ...(exception.details !== undefined ? { details: exception.details } : {}),
        correlationId,
      },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const fallbackCode = DEFAULT_CODES[status] ?? `http_${status}`;

    if (typeof response === 'string') {
      return { status, body: { code: fallbackCode, message: response, correlationId } };
    }

    const r = response as { code?: unknown; message?: unknown; details?: unknown };
    const message = Array.isArray(r.message) ? r.message.join('; ') : String(r.message ?? exception.message);
    return {
      status,
      body: {
        code: typeof r.code === 'string' ? r.code : fallbackCode,
        message,
        ...(r.details !== undefined ? { details: r.details } : {}),
        correlationId,
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'internal_error', message: 'Internal server error', correlationId },
  };
}
