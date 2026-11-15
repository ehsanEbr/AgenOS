import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { notAuthenticated } from '../application/errors';
import type { Principal } from '../domain/user';
import type { HttpRequest, RequestAuth } from './http';

export const IS_PUBLIC_KEY = 'agentos:public-route';

/**
 * Opts a route out of authentication. Every route is authenticated BY DEFAULT (the guard is global), so a route nobody annotated is
 * protected, not open: leaving something public takes a deliberate, visible `@Public()`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** The authenticated caller of this request (user, session and how the session was presented). */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): RequestAuth => {
  const auth = context.switchToHttp().getRequest<HttpRequest>().auth;
  if (!auth) throw notAuthenticated(); // a handler asked for the caller on a route the guard did not authenticate
  return auth;
});

/** Just the `Principal` (who), for code that must not depend on session details. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const auth = context.switchToHttp().getRequest<HttpRequest>().auth;
    if (!auth) throw notAuthenticated();
    return auth.principal;
  },
);
