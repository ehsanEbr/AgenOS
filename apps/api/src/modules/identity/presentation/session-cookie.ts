import type { IdentitySettings } from '../application/ports';
import type { SessionRecord } from '../domain/session';
import type { CookieOptions, HttpResponse } from './http';

/** The cookie name for a given origin scheme: the `__Host-` prefix (which browsers only honor for Secure, Path=/, Domain-less cookies) over HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-agentos_session' : 'agentos_session';
}

/** Reads one cookie from a `Cookie` header. Cookies with the same name: the first wins. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function attributes(settings: IdentitySettings): Omit<CookieOptions, 'maxAge'> {
  return {
    httpOnly: true, // not readable by page scripts, so an XSS cannot steal the session
    secure: settings.secureCookies, // follows the CONFIGURED origin's scheme, never what the request looks like
    sameSite: 'lax',
    path: '/', // required by __Host-; no Domain attribute is ever set
  };
}

/**
 * Sets the session cookie. Its Max-Age is the remaining ABSOLUTE lifetime; the server enforces expiry itself (idle and absolute) and
 * never trusts the cookie's.
 */
export function setSessionCookie(
  response: HttpResponse,
  settings: IdentitySettings,
  token: string,
  session: SessionRecord,
  now: Date,
): void {
  const maxAge = Math.max(0, session.absoluteExpiresAt.getTime() - now.getTime());
  response.cookie(settings.cookieName, token, { ...attributes(settings), maxAge });
}

export function clearSessionCookie(response: HttpResponse, settings: IdentitySettings): void {
  response.clearCookie(settings.cookieName, attributes(settings));
}
