import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { getCorrelationId } from './correlation-id.middleware';

/**
 * Per-request data that must be reachable from any code running on behalf of the request - services,
 * repositories, log statements - without threading `req` through every call.
 *
 * Uses Node's AsyncLocalStorage: the store follows the async call chain (await, timers, promises), and concurrent
 * requests never see each other's store. Keep this tiny. It is NOT a place for request-scoped business state;
 * pass business data explicitly.
 */
export interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Correlation ID of the request being processed, or undefined outside a request (startup, shutdown, tests). */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Opens the request context for everything downstream. Registered through RequestContextModule (a Nest module
 * middleware), NOT with `app.use()`: Nest runs module middleware AFTER the body parser, and stream events emitted
 * while the body is read would otherwise drop the store.
 */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  runWithRequestContext({ correlationId: getCorrelationId(req) ?? 'unknown' }, next);
}
