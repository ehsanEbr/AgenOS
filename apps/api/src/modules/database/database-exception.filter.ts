import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';
import { AppError } from '../../common/app-error';
import { PRISMA_ERROR_CLASSES, isDatabaseUnavailable } from './prisma-errors';

/**
 * Safety net for Prisma errors that a repository did not translate into an AppError.
 *
 * - Database unreachable/timed out -> 503 `database_unavailable` (retryable), not a misleading 500.
 * - Anything else -> 500 `internal_error`.
 *
 * Prisma error messages can embed query text and argument values (potentially user data), so the original message is
 * NEVER logged or returned: the response and the log line carry only the error class and Prisma code.
 *
 * It must be registered AFTER AllExceptionsFilter in AppModule (Nest gives later filters priority).
 */
@Catch(...PRISMA_ERROR_CLASSES)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly fallback = new AllExceptionsFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (isDatabaseUnavailable(exception)) {
      this.fallback.catch(
        new AppError(
          'unavailable',
          'database_unavailable',
          'The database is temporarily unavailable. Please retry.',
        ),
        host,
      );
      return;
    }

    const name = exception instanceof Error ? exception.name : 'PrismaError';
    const code = (exception as { code?: unknown }).code;
    // A fresh Error (no `cause`) so the unexpected-error log never contains Prisma's message or arguments.
    this.fallback.catch(
      new Error(`Unexpected database error (${name}${typeof code === 'string' ? ` ${code}` : ''})`),
      host,
    );
  }
}
