import type { SessionRecord } from '../domain/session';
import type { Principal, UserRecord } from '../domain/user';

/*
 * The parts of an HTTP request and response this module uses, described structurally. The presentation layer may not import Express
 * (lint), and these few members are all it needs; Express's request and response satisfy them.
 */

export type SessionCarrier = 'cookie' | 'token';

/** What the authentication guard attaches to a request it let through. It never holds the raw token. */
export interface RequestAuth {
  readonly principal: Principal;
  readonly user: UserRecord;
  readonly session: SessionRecord;
  /** How THIS request presented its session. A password change answers in the same way (new cookie, or new token in the body). */
  readonly carrier: SessionCarrier;
}

export interface HttpRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The client address as Express derives it (honors TRUST_PROXY_HOPS). */
  readonly ip?: string;
  auth?: RequestAuth;
}

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
}

export interface HttpResponse {
  cookie(name: string, value: string, options: CookieOptions): unknown;
  clearCookie(name: string, options: Omit<CookieOptions, 'maxAge'>): unknown;
}

/** First value of a header, as text. */
export function header(request: HttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
