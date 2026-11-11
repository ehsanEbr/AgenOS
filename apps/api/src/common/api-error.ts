import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiError } from '@agentos/contracts';

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
 * Converts any thrown value into the standard ApiError body (spec section 7.2).
 * Non-HTTP exceptions never leak their message to the client.
 */
export function toApiError(exception: unknown, correlationId: string): { status: number; body: ApiError } {
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
