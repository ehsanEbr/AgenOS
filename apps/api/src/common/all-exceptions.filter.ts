import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { classifyError, toApiError } from './api-error';
import { type CorrelatedRequest, getCorrelationId } from './correlation-id.middleware';

/**
 * The single place where errors become HTTP responses.
 *
 * Logging policy (so dashboards can alert on real problems):
 * - unexpected errors  -> `error` with the stack: someone must look at it
 * - expected 5xx       -> `warn` (a dependency is down, a retry may work), no stack
 * - expected 4xx       -> not logged here; the request log already records the status code
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<CorrelatedRequest>();
    const res = http.getResponse<Response>();

    const correlationId = getCorrelationId(req) ?? 'unknown';
    const { status, body } = toApiError(exception, correlationId);
    const errorClass = classifyError(exception);

    if (errorClass === 'unexpected') {
      this.logger.error(
        { err: exception },
        exception instanceof Error ? exception.message : 'Unhandled exception',
      );
    } else if (status >= 500) {
      this.logger.warn({ code: body.code, status }, `Request failed: ${body.message}`);
    }

    res.status(status).json(body);
  }
}
