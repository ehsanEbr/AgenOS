import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';
import { waitFor } from '../src/wait';

/*
 * Authentication through the complete stack as a black box (ADR-0010): the web container proxies /api to the API container, which
 * connects to PostgreSQL as its own non-superuser role against tables the migration role created, and uses Redis for rate limiting.
 * One throwaway project (own volumes, network, ports and generated credentials). The tests run in order and share the stack.
 */

let stack: Stack;
let origin: string; // what a browser would send as Origin: the configured WEB_ORIGIN
const PASSWORD = 'a long system test password';
const EMAIL = 'first.user@example.com';

beforeAll(async () => {
  stack = await Stack.create();
  await stack.up(['api', 'web']); // postgres, db-roles, migrate and redis first
  origin = `http://localhost:${stack.ports.web}`;
});
afterAll(async () => {
  await stack.destroy();
});

/** A request through the web container's proxy, like a browser. */
const viaWeb = (
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) =>
  fetch(stack.webUrl(`/api/v1${path}`), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.startsWith('agentos_session='));
const sqlAs = (user: string, password: string, sql: string) =>
  stack.exec('postgres', [
    'env',
    `PGPASSWORD=${password}`,
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    user,
    '-d',
    'agentos',
    '-tAc',
    sql,
  ]);

describe('the migrations ran as the migration role and the API runs as its own role', () => {
  it('the identity and audit tables are owned by agentos_migrate, and the API role holds only the granted privileges', async () => {
    const owners = await sqlAs(
      'agentos_migrate',
      stack.migratePassword,
      "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname IN ('identity', 'security')",
    );
    expect(owners.stdout.trim()).toBe('agentos_migrate');

    const privileges = await sqlAs(
      'agentos_migrate',
      stack.migratePassword,
      `SELECT concat_ws(',',
         has_table_privilege('agentos_api', 'identity.user', 'INSERT'),
         has_table_privilege('agentos_api', 'identity.user', 'DELETE'),
         has_table_privilege('agentos_api', 'security.audit_log', 'INSERT'),
         has_table_privilege('agentos_api', 'security.audit_log', 'SELECT'),
         has_table_privilege('agentos_api', 'security.audit_log', 'UPDATE'),
         has_table_privilege('agentos_api', 'security.audit_log', 'DELETE'))`,
    );
    expect(privileges.stdout.trim()).toBe('t,f,t,f,f,f'); // psql prints booleans as t and f: INSERT on user yes, DELETE no; audit INSERT yes, SELECT, UPDATE, DELETE no;
  });
});

describe('bootstrap, sign-in and sessions through the web container', () => {
  let cookie: string;

  it('lets the first user register on the empty instance and closes registration for everyone after', async () => {
    const first = await viaWeb('/auth/register', {
      body: { email: EMAIL, displayName: 'First User', password: PASSWORD },
      headers: { origin },
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ user: { email: EMAIL, status: 'active' } });

    const second = await viaWeb('/auth/register', {
      body: { email: 'second@example.com', displayName: 'Second', password: PASSWORD },
      headers: { origin },
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ code: 'registration_closed' });
  });

  it('signs in with an HttpOnly, SameSite=Lax cookie, and /me works through the proxy only with it', async () => {
    const response = await viaWeb('/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
      headers: { origin },
    });
    expect(response.status).toBe(200);
    const setCookie = sessionCookie(response);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    cookie = (setCookie as string).split(';')[0] as string;

    const me = await viaWeb('/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: EMAIL } });
    expect((await viaWeb('/me')).status).toBe(401);
  });

  it('refuses a cookie-authenticated state change from another origin (CSRF) and accepts the configured one', async () => {
    const forged = await viaWeb('/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(forged.status).toBe(403);
    expect((await viaWeb('/me', { headers: { cookie } })).status).toBe(200); // the forged request ended nothing

    const own = await viaWeb('/auth/logout', { method: 'POST', headers: { cookie, origin } });
    expect(own.status).toBe(204);
    expect((await viaWeb('/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('when Redis is lost', () => {
  it('stops new sign-ins and registrations (503, fail closed) while an existing session keeps working, and recovers with Redis', async () => {
    const signedIn = await viaWeb('/auth/login', {
      body: { email: EMAIL, password: PASSWORD, delivery: 'token' },
      headers: { origin },
    });
    expect(signedIn.status).toBe(200);
    const { token } = (await signedIn.json()) as { token: string };
    const bearer = { authorization: `Bearer ${token}` };

    expect((await stack.compose(['stop', '--timeout', '20', 'redis'])).code).toBe(0);
    try {
      const refused = await viaWeb('/auth/login', {
        body: { email: EMAIL, password: PASSWORD },
        headers: { origin },
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: 'authentication_unavailable' });
      expect(sessionCookie(refused)).toBeUndefined();
      expect(
        (
          await viaWeb('/auth/register', {
            body: { email: 'late@example.com', displayName: 'Late', password: PASSWORD },
            headers: { origin },
          })
        ).status,
      ).toBe(503);

      // Everything that needs only PostgreSQL keeps working.
      expect((await viaWeb('/me', { headers: bearer })).status).toBe(200);
      expect((await viaWeb('/auth/logout', { method: 'POST', headers: bearer })).status).toBe(204);
      expect((await viaWeb('/me', { headers: bearer })).status).toBe(401);
    } finally {
      expect((await stack.compose(['start', 'redis'])).code).toBe(0);
    }

    await waitFor(
      async () => {
        const again = await viaWeb('/auth/login', {
          body: { email: EMAIL, password: PASSWORD },
          headers: { origin },
        });
        return again.status === 200 ? again : undefined;
      },
      { message: 'sign-in to work again after Redis returned', timeoutMs: 90_000 },
    );
  });
});

describe('the audit trail and rate limiting', () => {
  it('recorded every step, and the API role cannot read, change or empty it (the owner is stopped by the triggers)', async () => {
    const actions = await sqlAs(
      'agentos_migrate',
      stack.migratePassword,
      "SELECT string_agg(action, ',' ORDER BY occurred_at) FROM security.audit_log",
    );
    expect(actions.stdout.trim()).toBe(
      'auth.registered,auth.login_succeeded,auth.logout,auth.login_succeeded,auth.logout,auth.login_succeeded',
    );

    for (const statement of [
      'SELECT count(*) FROM security.audit_log',
      "UPDATE security.audit_log SET action = 'x'",
      'DELETE FROM security.audit_log',
      'TRUNCATE security.audit_log',
    ]) {
      const attempt = await sqlAs('agentos_api', stack.appPassword, statement);
      expect(attempt.code, statement).not.toBe(0);
      expect(attempt.stderr, statement).toMatch(/permission denied/i);
    }
    const asOwner = await sqlAs('agentos_migrate', stack.migratePassword, 'TRUNCATE security.audit_log');
    expect(asOwner.stderr).toMatch(/append-only/i);
  });

  it('rate limits sign-in per account even when every request spoofs a different X-Forwarded-For (the proxy sets the real address)', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const response = await viaWeb('/auth/login', {
        body: { email: EMAIL, password: `wrong password ${i} xxxx` },
        headers: { origin, 'x-forwarded-for': `203.0.113.${i + 1}` },
      });
      last = response.status;
      if (i < 10) expect(response.status).toBe(401);
    }
    expect(last).toBe(429);
    const blocked = await viaWeb('/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
      headers: { origin },
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
