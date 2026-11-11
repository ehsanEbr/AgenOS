import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { toApiError } from './api-error';
import { type CorrelatedRequest, getCorrelationId } from './correlation-id.middleware';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<CorrelatedRequest>();
    const res = http.getResponse<Response>();

    const correlationId = getCorrelationId(req) ?? 'unknown';
    const { status, body } = toApiError(exception, correlationId);

    if (status >= 500) {
      this.logger.error(
        { correlationId, err: exception },
        exception instanceof Error ? exception.message : 'Unhandled exception',
      );
    }

    res.status(status).json(body);
  }
}
