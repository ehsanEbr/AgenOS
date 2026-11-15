import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { SETTINGS } from '../../../../test/support/identity-fakes';
import type { AuthenticatedSession, SessionService } from '../application/session.service';
import { AuthenticationGuard } from './authentication.guard';
import { assertAllowedOrigin, assertJsonWhenBodyPresent, isUnsafeMethod } from './csrf';
import { Public } from './decorators';
import type { HttpRequest, HttpResponse } from './http';
import { clearSessionCookie, readCookie, sessionCookieName, setSessionCookie } from './session-cookie';

const TOKEN = 'T'.repeat(43);
const OTHER_TOKEN = 'U'.repeat(43);
const authenticated = {
  principal: { userId: 'u', sessionId: 's' },
  user: {},
  session: {},
} as unknown as AuthenticatedSession;

class Routes {
  @Public()
  open(): void {}
  closed(): void {}
}

function guardWith(resolve: (token: string) => Promise<AuthenticatedSession | null>) {
  const sessions = { resolve: vi.fn(resolve) } as unknown as SessionService & {
    resolve: ReturnType<typeof vi.fn>;
  };
  return { guard: new AuthenticationGuard(new Reflector(), sessions, SETTINGS), sessions };
}

function contextFor(request: HttpRequest, handler: () => void = Routes.prototype.closed): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const request = (method: string, headers: Record<string, string> = {}): HttpRequest => ({ method, headers });

describe('AuthenticationGuard: authentication is the default', () => {
  it('lets a route marked @Public() through without looking for credentials', async () => {
    const { guard, sessions } = guardWith(async () => null);
    expect(await guard.canActivate(contextFor(request('GET'), Routes.prototype.open))).toBe(true);
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('rejects an unannotated route that has no credentials (401), so forgetting @Public() protects instead of exposing', async () => {
    const { guard } = guardWith(async () => authenticated);
    await expect(guard.canActivate(contextFor(request('GET')))).rejects.toMatchObject({
      kind: 'unauthenticated',
      code: 'unauthenticated',
    });
  });

  it('accepts a session cookie and a bearer token as two carriers of the same session, and records which one was used', async () => {
    const { guard, sessions } = guardWith(async () => authenticated);
    const viaCookie = request('GET', { cookie: `other=1; agentos_session=${TOKEN}; x=y` });
    await guard.canActivate(contextFor(viaCookie));
    expect(sessions.resolve).toHaveBeenLastCalledWith(TOKEN);
    expect(viaCookie.auth?.carrier).toBe('cookie');

    const viaBearer = request('GET', { authorization: `Bearer ${TOKEN}` });
    await guard.canActivate(contextFor(viaBearer));
    expect(sessions.resolve).toHaveBeenLastCalledWith(TOKEN);
    expect(viaBearer.auth?.carrier).toBe('token');
    expect(viaBearer.auth?.principal).toEqual(viaCookie.auth?.principal); // same session semantics either way
  });

  it('refuses a request that presents BOTH a cookie and a bearer token, whatever they contain', async () => {
    const { guard, sessions } = guardWith(async () => authenticated);
    const both = request('GET', {
      cookie: `agentos_session=${TOKEN}`,
      authorization: `Bearer ${OTHER_TOKEN}`,
    });
    await expect(guard.canActivate(contextFor(both))).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('gives the same 401 for an unknown, expired or revoked token and ignores a non-bearer Authorization header', async () => {
    const { guard } = guardWith(async () => null);
    const unknown = guard.canActivate(contextFor(request('GET', { authorization: `Bearer ${TOKEN}` })));
    await expect(unknown).rejects.toMatchObject({ kind: 'unauthenticated', code: 'unauthenticated' });
    const basic = guard.canActivate(contextFor(request('GET', { authorization: 'Basic dXNlcjpwYXNz' })));
    await expect(basic).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('CSRF defense for the cookie carrier', () => {
  const cookie = `agentos_session=${TOKEN}`;
  const web = SETTINGS.webOrigin;

  it('rejects a state-changing cookie request from another origin, or from none (403 origin_not_allowed)', async () => {
    const { guard, sessions } = guardWith(async () => authenticated);
    const forbidden: Array<Record<string, string>> = [
      { cookie, origin: 'https://evil.example' },
      { cookie, origin: 'null' }, // sandboxed iframes and some redirects
      { cookie, origin: `${web}.evil.example` },
      { cookie }, // no Origin and no Sec-Fetch-Site
      { cookie, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of forbidden) {
      await expect(guard.canActivate(contextFor(request('POST', headers)))).rejects.toMatchObject({
        kind: 'forbidden',
        code: 'origin_not_allowed',
      });
    }
    expect(sessions.resolve).not.toHaveBeenCalled(); // refused before the session is even looked up
  });

  it('accepts the configured origin, or a same-origin fetch that sends no Origin', async () => {
    const { guard } = guardWith(async () => authenticated);
    expect(await guard.canActivate(contextFor(request('POST', { cookie, origin: web })))).toBe(true);
    expect(
      await guard.canActivate(contextFor(request('DELETE', { cookie, 'sec-fetch-site': 'same-origin' }))),
    ).toBe(true);
  });

  it('does not apply to safe methods (GET/HEAD) or to the bearer carrier, which a browser never attaches by itself', async () => {
    const { guard } = guardWith(async () => authenticated);
    expect(await guard.canActivate(contextFor(request('GET', { cookie })))).toBe(true);
    expect(await guard.canActivate(contextFor(request('HEAD', { cookie })))).toBe(true);
    expect(
      await guard.canActivate(
        contextFor(request('POST', { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })),
      ),
    ).toBe(true);
  });

  it('requires a JSON body when a cookie request carries one, and is silent when there is no body (logout)', async () => {
    const { guard } = guardWith(async () => authenticated);
    const withBody = (contentType?: string) =>
      request('POST', {
        cookie,
        origin: web,
        'content-length': '12',
        ...(contentType ? { 'content-type': contentType } : {}),
      });
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])
      await expect(guard.canActivate(contextFor(withBody(type)))).rejects.toMatchObject({
        code: 'json_required',
      });
    expect(await guard.canActivate(contextFor(withBody('application/json')))).toBe(true);
    expect(await guard.canActivate(contextFor(withBody('application/json; charset=utf-8')))).toBe(true);
    expect(await guard.canActivate(contextFor(request('POST', { cookie, origin: web })))).toBe(true);
  });

  it('checks the Origin of the public sign-in and registration endpoints only when the browser sent one (login CSRF)', () => {
    expect(() => assertAllowedOrigin(request('POST'), web, { required: false })).not.toThrow();
    expect(() =>
      assertAllowedOrigin(request('POST', { origin: web }), web, { required: false }),
    ).not.toThrow();
    expect(() =>
      assertAllowedOrigin(request('POST', { origin: 'https://evil.example' }), web, { required: false }),
    ).toThrow(/allowed origin/);
  });

  it('knows which methods change state', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post'])
      expect(isUnsafeMethod(method)).toBe(true);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(isUnsafeMethod(method)).toBe(false);
    expect(() => assertJsonWhenBodyPresent(request('POST'))).not.toThrow();
  });
});

describe('the session cookie', () => {
  const recorder = () => {
    const calls: Array<{ name: string; value?: string; options: Record<string, unknown> }> = [];
    const response: HttpResponse = {
      cookie: (name, value, options) => calls.push({ name, value, options: { ...options } }),
      clearCookie: (name, options) => calls.push({ name, options: { ...options } }),
    };
    return { calls, response };
  };
  const session = { absoluteExpiresAt: new Date('2026-03-02T12:00:00Z') } as never;
  const now = new Date('2026-03-01T12:00:00Z');

  it('is HttpOnly, SameSite=Lax, path /, with no Domain, and lives as long as the absolute lifetime has left', () => {
    const { calls, response } = recorder();
    setSessionCookie(response, SETTINGS, TOKEN, session, now);
    expect(calls[0]).toEqual({
      name: 'agentos_session',
      value: TOKEN,
      options: { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 24 * 3_600_000 },
    });
    expect(calls[0]?.options).not.toHaveProperty('domain');
  });

  it('is Secure and uses the __Host- prefix when the configured origin is https (never decided from the request)', () => {
    const https = { ...SETTINGS, secureCookies: true, cookieName: sessionCookieName(true) };
    const { calls, response } = recorder();
    setSessionCookie(response, https, TOKEN, session, now);
    expect(calls[0]).toMatchObject({
      name: '__Host-agentos_session',
      options: { secure: true, path: '/', httpOnly: true },
    });
    expect(calls[0]?.options).not.toHaveProperty('domain'); // __Host- forbids it
  });

  it('is cleared with the same attributes, so the browser really removes it', () => {
    const { calls, response } = recorder();
    clearSessionCookie(response, SETTINGS);
    expect(calls[0]).toEqual({
      name: 'agentos_session',
      options: { httpOnly: true, secure: false, sameSite: 'lax', path: '/' },
    });
  });

  it('is read from a Cookie header by exact name', () => {
    expect(readCookie('a=1; agentos_session=abc; b=2', 'agentos_session')).toBe('abc');
    expect(readCookie('xagentos_session=abc', 'agentos_session')).toBeUndefined();
    expect(readCookie(undefined, 'agentos_session')).toBeUndefined();
    expect(readCookie('agentos_session=first; agentos_session=second', 'agentos_session')).toBe('first');
  });
});
