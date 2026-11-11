import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_ID_HEADER } from '@agentos/contracts';

export type CorrelatedRequest = Request & { correlationId: string };

const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Assigns a correlation ID to every request. A caller-supplied ID is reused only if it is
 * well-formed (prevents log injection); otherwise a fresh UUID is generated.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const id = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
  (req as CorrelatedRequest).correlationId = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  next();
}

export function getCorrelationId(req: IncomingMessage | Request): string | undefined {
  return (req as Partial<CorrelatedRequest>).correlationId;
}
