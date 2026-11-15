import 'reflect-metadata';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { Logger as PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS, apiErrorSchema, loginResponseSchema, meResponseSchema } from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { AUDIT_REPOSITORY } from '../src/modules/audit/application/audit-repository';
import { APP_CONFIG, type ApiConfig, loadApiConfig } from '../src/modules/config';
import { THROTTLE } from '../src/modules/identity/application/ports';
import { formatPasswordHash } from '../src/modules/identity/domain/password-hash';
import { THROTTLE_RULES } from '../src/modules/identity/domain/throttle-policy';
import { RedisThrottle } from '../src/modules/identity/infrastructure/redis-throttle';
import { RedisService } from '../src/modules/redis';
import { type IsolatedDatabase, adminDatabaseUrl, createIsolatedDatabase } from './support/isolated-database';

/*
 * The identity API end to end, in-process, against REAL PostgreSQL (a throwaway database with the real migrations, connecting as
 * the non-superuser API role) and REAL Redis (rate-limit counters under a unique prefix in logical database 15).
 * Requires `pnpm infra:up`.
 */

const WEB = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const SECRETS: string[] = []; // every password and token this file handles: none may ever appear in the audit trail or the logs

const uid = () => randomBytes(4).toString('hex');
const emailOf = (name: string) => `${name}-${uid()}@example.com`;
let addressCounter = 0;
/** A distinct client address per call (the app trusts one proxy hop), so per-address limits never leak between tests. */
const nextAddress = () =>
  `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter++ & 255}`;

function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/15';
  return parsed.toString();
}

const redisPrefix = `it:${uid()}:authn`;
let db: IsolatedDatabase;
let owner: PrismaClient; // the migration role: used only to INSPECT and to age sessions

interface AppOptions {
  allowRegistration?: boolean;
  redisUrl?: string;
  database?: IsolatedDatabase;
  failingAudit?: boolean;
}

async function createApp(options: AppOptions = {}): Promise<INestApplication> {
  const base = loadApiConfig();
  const config: ApiConfig = {
    ...base,
    DATABASE_URL: (options.database ?? db).urlFor('api'),
    REDIS_URL: options.redisUrl ?? isolatedRedisUrl(base.REDIS_URL),
    WEB_ORIGIN: WEB,
    TRUST_PROXY_HOPS: 1,
    AUTH_ALLOW_REGISTRATION: options.allowRegistration ?? false,
  };
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(THROTTLE)
    .useFactory({
      factory: (redis: RedisService) => new RedisThrottle(redis, redisPrefix),
      inject: [RedisService],
    });
  if (options.failingAudit)
    builder = builder
      .overrideProvider(AUDIT_REPOSITORY)
      .useValue({ append: () => Promise.reject(new Error('audit store unavailable')) });
  const app = (await builder.compile()).createNestApplication({ bufferLogs: true });
  configureApp(app, config);
  await app.init();
  return app;
}

/** A thin supertest wrapper: JSON bodies, a distinct client address by default. */
function client(app: INestApplication) {
  const send = (
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const agent = request(app.getHttpServer());
    const req = (method === 'get' ? agent.get(`/api/v1${path}`) : agent.post(`/api/v1${path}`))
      .set('X-Forwarded-For', nextAddress())
      .set(headers);
    return body === undefined ? req : req.send(body as object);
  };
  return {
    get: (path: string, headers?: Record<string, string>) => send('get', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) =>
      send('post', path, body, headers),
  };
}

const cookieOf = (
  response: { headers: Record<string, unknown> },
  name = 'agentos_session',
): string | undefined => {
  const header = response.headers['set-cookie'] as string[] | undefined;
  return header?.find((c) => c.startsWith(`${name}=`));
};
const cookieValue = (setCookie: string | undefined) => setCookie?.split(';')[0]?.split('=')[1] ?? '';
const asCookie = (value: string) => ({ Cookie: `agentos_session=${value}`, Origin: WEB });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function register(app: INestApplication, email: string, password = PASSWORD) {
  SECRETS.push(password);
  return client(app).post('/auth/register', { email, displayName: 'Test User', password });
}
async function loginToken(app: INestApplication, email: string, password = PASSWORD): Promise<string> {
  const response = await client(app).post('/auth/login', { email, password, delivery: 'token' }).expect(200);
  const token = loginResponseSchema.parse(response.body).token as string;
  SECRETS.push(token);
  return token;
}
const auditRows = (database: PrismaClient = owner) =>
  database.auditLog.findMany({ orderBy: { occurredAt: 'asc' } });

beforeAll(async () => {
  db = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
  await db.applyMigrations();
  owner = new PrismaClient({ datasourceUrl: db.urlFor('migrate') });
});

afterAll(async () => {
  await owner?.$disconnect();
  await db?.drop();
  // Remove this run's rate-limit counters.
  const app = await createApp({ allowRegistration: true }).catch(() => undefined);
  if (app) {
    const redis = app.get(RedisService).client;
    const keys = await redis.keys(`${redisPrefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await app.close();
  }
});

describe('instance bootstrap and registration', () => {
  it('lets the first user register on an empty instance and then closes registration (403 registration_closed)', async () => {
    const fresh = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
    await fresh.applyMigrations();
    const app = await createApp({ database: fresh });
    const inspector = new PrismaClient({ datasourceUrl: fresh.urlFor('migrate') });
    try {
      const first = await register(app, emailOf('first'));
      expect(first.status).toBe(201);
      expect(first.body.user).toMatchObject({ status: 'active', displayName: 'Test User' });
      expect(JSON.stringify(first.body)).not.toMatch(/password|hash|token/i);

      const second = await register(app, emailOf('second'));
      expect(second.status).toBe(403);
      expect(apiErrorSchema.parse(second.body).code).toBe('registration_closed');
      expect(await inspector.user.count()).toBe(1);

      const rows = await auditRows(inspector);
      expect(rows.filter((r) => r.action === 'auth.registered')).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({ bootstrap: true });
    } finally {
      await app.close();
      await inspector.$disconnect();
      await fresh.drop();
    }
  });

  it('is safe against concurrent bootstrap: of many simultaneous first registrations exactly one wins', async () => {
    const fresh = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
    await fresh.applyMigrations();
    const app = await createApp({ database: fresh });
    const inspector = new PrismaClient({ datasourceUrl: fresh.urlFor('migrate') });
    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) => register(app, emailOf(`racer${i}`))),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 403, 403, 403, 403]);
      expect(await inspector.user.count()).toBe(1);
      expect(await inspector.credential.count()).toBe(1);
      const registered = (await auditRows(inspector)).filter((r) => r.action === 'auth.registered');
      expect(registered).toHaveLength(1);
      expect(registered[0]?.metadata).toEqual({ bootstrap: true });
    } finally {
      await app.close();
      await inspector.$disconnect();
      await fresh.drop();
    }
  });

  it('accepts further registrations only when the operator enabled them, and refuses a duplicate email', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const email = emailOf('open');
      expect((await register(app, email)).status).toBe(201);
      const duplicate = await register(app, email);
      expect(duplicate.status).toBe(409);
      expect(apiErrorSchema.parse(duplicate.body).code).toBe('email_taken');
      // The address is one identity whatever its case or spacing.
      const shouting = await register(app, `  ${email.toUpperCase()} `);
      expect(shouting.status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid registration with per-field details and creates nothing', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const before = await owner.user.count();
      const weak = await register(app, emailOf('weak'), 'too short');
      expect(weak.status).toBe(400);
      expect(apiErrorSchema.parse(weak.body).details).toEqual([
        expect.objectContaining({ path: 'password' }),
      ]);
      const notEmail = await client(app).post('/auth/register', {
        email: 'nope',
        displayName: 'x',
        password: PASSWORD,
      });
      expect(notEmail.status).toBe(400);
      expect(await owner.user.count()).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('checks the Origin of a registration or sign-in only when the browser sent one (login CSRF)', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const email = emailOf('origin');
      await register(app, email);
      const evil = await client(app)
        .post('/auth/login', { email, password: PASSWORD }, { Origin: 'https://evil.example' })
        .expect(403);
      expect(apiErrorSchema.parse(evil.body).code).toBe('origin_not_allowed');
      expect(cookieOf(evil)).toBeUndefined();
      await client(app).post('/auth/login', { email, password: PASSWORD }, { Origin: WEB }).expect(200);
      await client(app).post('/auth/login', { email, password: PASSWORD }).expect(200); // a non-browser client sends no Origin
    } finally {
      await app.close();
    }
  });
});

describe('sign-in, sessions and the two carriers', () => {
  let app: INestApplication;
  const alice = emailOf('alice');
  beforeAll(async () => {
    app = await createApp({ allowRegistration: true });
    expect((await register(app, alice)).status).toBe(201);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('cookie sign-in: an HttpOnly, SameSite=Lax cookie with no Domain, the token never in the body, stored only as a hash', async () => {
    const response = await client(app)
      .post('/auth/login', { email: alice, password: PASSWORD }, { Origin: WEB })
      .expect(200);
    const parsed = loginResponseSchema.parse(response.body);
    expect(parsed.token).toBeUndefined();
    expect(parsed.user.email).toBe(alice);

    const setCookie = cookieOf(response);
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(setCookie).toMatch(/;\s*Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toMatch(/;\s*Secure/i); // plain-http localhost origin
    const token = cookieValue(setCookie);
    SECRETS.push(token);

    const stored = await owner.session.findUnique({ where: { tokenHash: sha256(token) } });
    expect(stored).not.toBeNull();
    expect(await owner.session.count({ where: { tokenHash: token } })).toBe(0); // the token itself is nowhere in the database
    expect(JSON.stringify(stored)).not.toContain(token);

    const me = await client(app).get('/me', asCookie(token)).expect(200);
    expect(meResponseSchema.parse(me.body).user.email).toBe(alice);
  });

  it('token sign-in: the token is returned once, no cookie is set, and it works as a bearer credential', async () => {
    const response = await client(app)
      .post('/auth/login', { email: alice, password: PASSWORD, delivery: 'token' })
      .expect(200);
    expect(cookieOf(response)).toBeUndefined();
    const { token } = loginResponseSchema.parse(response.body);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    SECRETS.push(token as string);
    const me = await client(app)
      .get('/me', bearer(token as string))
      .expect(200);
    expect(meResponseSchema.parse(me.body).user.email).toBe(alice);
  });

  it('is authenticated by default: no credentials is 401, an unknown route is still 404, and health stays public', async () => {
    const anonymous = await client(app).get('/me').expect(401);
    expect(apiErrorSchema.parse(anonymous.body).code).toBe('unauthenticated');
    await client(app).get('/definitely-not-a-route').expect(404);
    await client(app).get('/health').expect(200);
  });

  it('refuses a request that presents both a cookie and a bearer token, even when both are valid', async () => {
    const cookie = cookieValue(
      cookieOf(await client(app).post('/auth/login', { email: alice, password: PASSWORD }).expect(200)),
    );
    const token = await loginToken(app, alice);
    SECRETS.push(cookie);
    await client(app)
      .get('/me', { Cookie: `agentos_session=${cookie}`, ...bearer(token) })
      .expect(401);
    await client(app).get('/me', asCookie(cookie)).expect(200);
    await client(app).get('/me', bearer(token)).expect(200);
  });

  it('gives the SAME generic failure for an unknown email, a wrong password and a disabled account', async () => {
    const disabled = emailOf('disabled');
    await register(app, disabled);
    await owner.user.update({ where: { email: disabled }, data: { status: 'disabled' } });

    const attempts = await Promise.all([
      client(app).post('/auth/login', { email: emailOf('nobody'), password: PASSWORD }),
      client(app).post('/auth/login', { email: alice, password: 'definitely not the password' }),
      client(app).post('/auth/login', { email: disabled, password: PASSWORD }),
    ]);
    const shape = (r: (typeof attempts)[number]) => ({
      status: r.status,
      body: { ...r.body, correlationId: '<id>' },
      cookie: cookieOf(r),
    });
    expect(attempts.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(shape(attempts[0]!)).toEqual(shape(attempts[1]!));
    expect(shape(attempts[1]!)).toEqual(shape(attempts[2]!));
    expect(attempts[0]!.body).toMatchObject({
      code: 'invalid_credentials',
      message: 'Invalid email or password',
    });
  });

  it('enforces idle expiry, absolute expiry and revocation on the server, for the cookie and the bearer carrier alike', async () => {
    const email = emailOf('expiry');
    await register(app, email);
    const cookieToken = cookieValue(
      cookieOf(await client(app).post('/auth/login', { email, password: PASSWORD }).expect(200)),
    );
    const bearerToken = await loginToken(app, email);
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    const sessions = await owner.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(2);
    const [first, second] = sessions as [(typeof sessions)[number], (typeof sessions)[number]];

    const usable = async () => [
      (await client(app).get('/me', asCookie(cookieToken))).status,
      (await client(app).get('/me', bearer(bearerToken))).status,
    ];
    expect(await usable()).toEqual([200, 200]);

    const past = new Date(Date.now() - 1000);
    for (const [field, restore] of [
      ['idleExpiresAt', new Date(Date.now() + 3_600_000)],
      ['absoluteExpiresAt', new Date(Date.now() + 86_400_000)],
      ['revokedAt', null],
    ] as const) {
      await owner.session.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { [field]: past },
      });
      expect(await usable(), `${field} in the past`).toEqual([401, 401]);
      await owner.session.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { [field]: restore },
      });
      expect(await usable(), `${field} restored`).toEqual([200, 200]);
    }
  });

  it('slides the idle expiry on use (written at most once a minute) and never past the absolute expiry', async () => {
    const email = emailOf('slide');
    await register(app, email);
    const token = await loginToken(app, email);
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    const row = () => owner.session.findFirstOrThrow({ where: { userId: user.id } });
    const created = await row();

    await client(app).get('/me', bearer(token)).expect(200);
    expect((await row()).lastSeenAt).toEqual(created.lastSeenAt); // under a minute: not written

    await owner.session.update({
      where: { id: created.id },
      data: { lastSeenAt: new Date(Date.now() - 120_000) },
    });
    await client(app).get('/me', bearer(token)).expect(200);
    const touched = await row();
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(touched.idleExpiresAt.getTime()).toBeLessThanOrEqual(touched.absoluteExpiresAt.getTime());
  });

  it('logout ends only the current session, clears the cookie, and logout-all ends them all', async () => {
    const email = emailOf('logout');
    await register(app, email);
    const cookieA = cookieValue(
      cookieOf(await client(app).post('/auth/login', { email, password: PASSWORD }).expect(200)),
    );
    const tokenB = await loginToken(app, email);
    const tokenC = await loginToken(app, email);

    const out = await client(app).post('/auth/logout', undefined, asCookie(cookieA)).expect(204);
    const cleared = cookieOf(out);
    expect(cleared).toMatch(/^agentos_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
    await client(app).get('/me', asCookie(cookieA)).expect(401);
    await client(app).get('/me', bearer(tokenB)).expect(200);

    await client(app).post('/auth/logout-all', undefined, bearer(tokenB)).expect(204);
    await client(app).get('/me', bearer(tokenB)).expect(401);
    await client(app).get('/me', bearer(tokenC)).expect(401);

    const actions = (await auditRows()).filter(
      (r) => r.action === 'auth.logout' || r.action === 'auth.logout_all',
    );
    expect(actions.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.logout', 'auth.logout_all']));
    expect(actions.find((r) => r.action === 'auth.logout_all')?.metadata).toEqual({ revokedSessions: 2 });
  });

  it('rotates the session on a password change: other sessions end, the old token dies, cookie and bearer clients each get the new one', async () => {
    const email = emailOf('rotate');
    await register(app, email);
    const oldCookie = cookieValue(
      cookieOf(await client(app).post('/auth/login', { email, password: PASSWORD }).expect(200)),
    );
    const otherToken = await loginToken(app, email);
    const bearerOld = await loginToken(app, email);
    const NEW_PASSWORD = 'a brand new long password';
    SECRETS.push(NEW_PASSWORD);

    // Cookie carrier: a new cookie, no token in the body.
    const changed = await client(app)
      .post('/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, asCookie(oldCookie))
      .expect(200);
    expect(changed.body.token).toBeUndefined();
    const newCookie = cookieValue(cookieOf(changed));
    SECRETS.push(newCookie);
    expect(newCookie).not.toBe('');
    expect(newCookie).not.toBe(oldCookie);
    await client(app).get('/me', asCookie(oldCookie)).expect(401); // the old token of the same session no longer works
    await client(app).get('/me', asCookie(newCookie)).expect(200); // the same session, new token
    await client(app).get('/me', bearer(otherToken)).expect(401); // every other session ended
    await client(app).get('/me', bearer(bearerOld)).expect(401);

    // New password works, old one does not.
    await client(app).post('/auth/login', { email, password: PASSWORD }).expect(401);
    await client(app).post('/auth/login', { email, password: NEW_PASSWORD }).expect(200);

    // Bearer carrier: the new token comes back in the body, no cookie.
    const viaBearer = await loginToken(app, email, NEW_PASSWORD);
    const rotated = await client(app)
      .post('/me/password', { currentPassword: NEW_PASSWORD, newPassword: PASSWORD }, bearer(viaBearer))
      .expect(200);
    expect(cookieOf(rotated)).toBeUndefined();
    expect(rotated.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    SECRETS.push(rotated.body.token);
    await client(app).get('/me', bearer(viaBearer)).expect(401);
    await client(app).get('/me', bearer(rotated.body.token)).expect(200);

    const audit = (await auditRows()).filter((r) => r.action === 'auth.password_changed');
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a wrong current password with 422 and changes nothing', async () => {
    const email = emailOf('wrongcurrent');
    await register(app, email);
    const token = await loginToken(app, email);
    const refused = await client(app)
      .post(
        '/me/password',
        { currentPassword: 'not my password 1', newPassword: 'another long password' },
        bearer(token),
      )
      .expect(422);
    expect(apiErrorSchema.parse(refused.body).code).toBe('invalid_current_password');
    await client(app).get('/me', bearer(token)).expect(200); // the session is untouched
    await client(app).post('/auth/login', { email, password: PASSWORD }).expect(200); // and so is the password
  });
});

describe('CSRF defense for cookie-authenticated requests', () => {
  let app: INestApplication;
  let cookie: string;
  const csrfEmail = emailOf('csrf');
  beforeAll(async () => {
    app = await createApp({ allowRegistration: true });
    await register(app, csrfEmail);
    cookie = cookieValue(
      cookieOf(await client(app).post('/auth/login', { email: csrfEmail, password: PASSWORD }).expect(200)),
    );
    SECRETS.push(cookie);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('refuses a state-changing request from another origin, from a sandbox ("null"), or with no origin evidence', async () => {
    const refused: Array<Record<string, string>> = [
      { Cookie: `agentos_session=${cookie}`, Origin: 'https://evil.example' },
      { Cookie: `agentos_session=${cookie}`, Origin: 'null' },
      { Cookie: `agentos_session=${cookie}` },
      { Cookie: `agentos_session=${cookie}`, 'Sec-Fetch-Site': 'cross-site' },
    ];
    for (const headers of refused) {
      const response = await client(app).post('/auth/logout', undefined, headers).expect(403);
      expect(apiErrorSchema.parse(response.body).code).toBe('origin_not_allowed');
    }
    await client(app).get('/me', asCookie(cookie)).expect(200); // and the session was NOT ended by any of them
  });

  it('refuses a cookie request whose body is not JSON, and does not apply to safe methods or to the bearer carrier', async () => {
    const form = await request(app.getHttpServer())
      .post('/api/v1/me/password')
      .set(asCookie(cookie))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('currentPassword=x&newPassword=y')
      .expect(400);
    expect(apiErrorSchema.parse(form.body).code).toBe('json_required');

    await client(app)
      .get('/me', { Cookie: `agentos_session=${cookie}` })
      .expect(200); // GET needs no origin

    // The bearer carrier is not exposed to CSRF (a browser never attaches that header on its own): no Origin is needed.
    const token = await loginToken(app, csrfEmail);
    await client(app)
      .post('/auth/logout', undefined, { ...bearer(token), Origin: 'https://evil.example' })
      .expect(204);
  });

  it('accepts the configured origin', async () => {
    const response = await client(app).post('/auth/logout', undefined, asCookie(cookie)).expect(204);
    expect(response.status).toBe(204);
  });
});

describe('rate limiting with real Redis', () => {
  it('blocks an account after its failure budget, even for the right password, and records the throttle exactly once', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const email = emailOf('throttled');
      await register(app, email);
      const address = '198.51.100.77';
      const attempt = (password: string, em = email) =>
        client(app).post('/auth/login', { email: em, password }, { 'X-Forwarded-For': address });
      const max = THROTTLE_RULES['signin-account'].max;
      for (let i = 0; i < max; i++) expect((await attempt(`wrong password ${i} xx`)).status).toBe(401);

      const blocked = await attempt(PASSWORD);
      expect(blocked.status).toBe(429);
      expect(apiErrorSchema.parse(blocked.body).code).toBe('too_many_attempts');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(blocked.body)).not.toMatch(new RegExp(email));

      const user = await owner.user.findUniqueOrThrow({ where: { email } });
      const throttledFor = async () =>
        (await auditRows()).filter((r) => r.action === 'auth.login_throttled' && r.resourceId === user.id);
      const throttled = await throttledFor();
      expect(throttled.map((r) => r.metadata)).toEqual([{ scope: 'account' }]); // recorded once, on the failure that used the budget up
      await attempt(PASSWORD); // refused again, but not re-recorded
      expect(await throttledFor()).toHaveLength(1);

      // Another account from another address is unaffected.
      const other = emailOf('unaffected');
      await register(app, other);
      await client(app).post('/auth/login', { email: other, password: PASSWORD }).expect(200);
    } finally {
      await app.close();
    }
  });

  it('counts an unknown account exactly like a real one, so the limiter reveals nothing', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const ghost = emailOf('ghost');
      const address = '198.51.100.88';
      for (let i = 0; i < THROTTLE_RULES['signin-account'].max; i++)
        await client(app)
          .post(
            '/auth/login',
            { email: ghost, password: `guess ${i} ${uid()}` },
            { 'X-Forwarded-For': address },
          )
          .expect(401);
      await client(app)
        .post('/auth/login', { email: ghost, password: PASSWORD }, { 'X-Forwarded-For': address })
        .expect(429);
    } finally {
      await app.close();
    }
  });

  it('limits registrations per client address', async () => {
    const app = await createApp({ allowRegistration: true });
    try {
      const address = '198.51.100.99';
      for (let i = 0; i < THROTTLE_RULES['register-address'].max; i++) {
        const r = await client(app).post(
          '/auth/register',
          { email: emailOf('burst'), displayName: 'B', password: PASSWORD },
          { 'X-Forwarded-For': address },
        );
        expect(r.status).toBe(201);
      }
      const refused = await client(app).post(
        '/auth/register',
        { email: emailOf('burst'), displayName: 'B', password: PASSWORD },
        { 'X-Forwarded-For': address },
      );
      expect(refused.status).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe('when Redis is unavailable', () => {
  it('stops NEW sign-ins and registrations (503, fail closed) but keeps existing sessions, /me and logout working', async () => {
    const withRedis = await createApp({ allowRegistration: true });
    const email = emailOf('survivor');
    await register(withRedis, email);
    const token = await loginToken(withRedis, email);
    const secondToken = await loginToken(withRedis, email);
    await withRedis.close();

    const withoutRedis = await createApp({
      allowRegistration: true,
      redisUrl: 'redis://:nothing@127.0.0.1:1/15',
    });
    try {
      const signIn = await client(withoutRedis).post('/auth/login', { email, password: PASSWORD });
      expect(signIn.status).toBe(503);
      expect(apiErrorSchema.parse(signIn.body).code).toBe('authentication_unavailable');
      expect(signIn.headers['retry-after']).toBeDefined();
      expect(JSON.stringify(signIn.body)).not.toMatch(/redis|127\.0\.0\.1|nothing/i);
      expect(cookieOf(signIn)).toBeUndefined();

      const registration = await register(withoutRedis, emailOf('blocked'));
      expect(registration.status).toBe(503);
      expect(await owner.user.count({ where: { email: { startsWith: 'blocked-' } } })).toBe(0);

      const changePassword = await client(withoutRedis).post(
        '/me/password',
        { currentPassword: PASSWORD, newPassword: 'another long password' },
        bearer(token),
      );
      expect(changePassword.status).toBe(503);

      // Everything that only needs PostgreSQL keeps working.
      await client(withoutRedis).get('/me', bearer(token)).expect(200);
      await client(withoutRedis).get('/me', bearer(secondToken)).expect(200);
      await client(withoutRedis).post('/auth/logout', undefined, bearer(token)).expect(204);
      await client(withoutRedis).get('/me', bearer(token)).expect(401);
      await client(withoutRedis).post('/auth/logout-all', undefined, bearer(secondToken)).expect(204);
    } finally {
      await withoutRedis.close();
    }
  });
});

const CODE = (...points: number[]) => points.map((point) => String.fromCodePoint(point)).join('');

describe('the audit append is atomic with every session change (C1)', () => {
  let normal: INestApplication; // the audit store works
  let failing: INestApplication; // the audit append always fails: the change it should have recorded must not survive
  beforeAll(async () => {
    normal = await createApp({ allowRegistration: true });
    failing = await createApp({ allowRegistration: true, failingAudit: true });
  });
  afterAll(async () => {
    await Promise.all([normal?.close(), failing?.close()]);
  });

  /** A user with two live bearer sessions, plus a way to see everything those operations could have changed. */
  async function seed() {
    const email = emailOf('atomic');
    expect((await register(normal, email)).status).toBe(201);
    const tokenA = await loginToken(normal, email);
    const tokenB = await loginToken(normal, email);
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    const snapshot = async () => ({
      // Everything a session operation can change: which sessions exist, their tokens and whether they are revoked.
      sessions: (
        await owner.session.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })
      ).map((row) => ({
        id: row.id,
        tokenHash: row.tokenHash,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
      })),
      passwordHash: (await owner.credential.findUniqueOrThrow({ where: { userId: user.id } })).passwordHash,
      auditRows: await owner.auditLog.count({ where: { actorUserId: user.id } }),
    });
    return { email, user, tokenA, tokenB, snapshot };
  }

  const internalError = (response: { status: number; body: unknown }) => {
    expect(response.status).toBe(500);
    expect(apiErrorSchema.parse(response.body).code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toMatch(/audit|unavailable|store/i); // nothing about the cause leaks
  };

  it('password change: 500, the password is not changed, no session is revoked or rotated, existing tokens still work', async () => {
    const { email, tokenA, tokenB, snapshot } = await seed();
    const before = await snapshot();
    const NEW_PASSWORD = 'must never become the password';
    SECRETS.push(NEW_PASSWORD);

    internalError(
      await client(failing).post(
        '/me/password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        bearer(tokenA),
      ),
    );

    expect(await snapshot()).toEqual(before); // hash, tokens, revocations and audit rows: all exactly as before
    await client(failing).get('/me', bearer(tokenA)).expect(200); // not rotated, not revoked
    await client(failing).get('/me', bearer(tokenB)).expect(200); // the other session was not revoked
    await client(normal).post('/auth/login', { email, password: PASSWORD }).expect(200); // the old password still works
    await client(normal).post('/auth/login', { email, password: NEW_PASSWORD }).expect(401); // and the new one never took effect
  });

  it('logout-all: 500 and not one session is revoked', async () => {
    const { tokenA, tokenB, snapshot } = await seed();
    const before = await snapshot();

    internalError(await client(failing).post('/auth/logout-all', undefined, bearer(tokenA)));

    expect(await snapshot()).toEqual(before);
    expect(before.sessions.every((session) => session.revokedAt === null)).toBe(true);
    await client(failing).get('/me', bearer(tokenA)).expect(200);
    await client(failing).get('/me', bearer(tokenB)).expect(200);
  });

  it('logout: 500 and the session stays valid', async () => {
    const { tokenA, tokenB, snapshot } = await seed();
    const before = await snapshot();

    internalError(await client(failing).post('/auth/logout', undefined, bearer(tokenA)));

    expect(await snapshot()).toEqual(before);
    await client(failing).get('/me', bearer(tokenA)).expect(200); // still signed in
    await client(failing).get('/me', bearer(tokenB)).expect(200);
  });

  it('sign-in: 500, no session is created, no cookie is set, no token is returned', async () => {
    const { email, snapshot } = await seed();
    const before = await snapshot();

    const cookieAttempt = await client(failing).post(
      '/auth/login',
      { email, password: PASSWORD },
      { Origin: WEB },
    );
    internalError(cookieAttempt);
    expect(cookieOf(cookieAttempt)).toBeUndefined();
    const tokenAttempt = await client(failing).post('/auth/login', {
      email,
      password: PASSWORD,
      delivery: 'token',
    });
    internalError(tokenAttempt);
    expect(tokenAttempt.body.token).toBeUndefined();

    const after = await snapshot();
    expect(after.sessions).toHaveLength(before.sessions.length); // no session row survived the failed sign-ins
    expect(after).toEqual(before);
  });

  it('sign-in that would also upgrade a weaker stored hash: the upgrade is rolled back with everything else', async () => {
    const { email, user, snapshot } = await seed();
    // A hash made the way an earlier, cheaper policy would have made it (N = 2^14).
    const salt = randomBytes(16);
    const key = scryptSync(Buffer.from(PASSWORD, 'utf8'), salt, 32, { N: 2 ** 14, r: 8, p: 1 });
    const legacy = formatPasswordHash({
      version: 1,
      costLog2: 14,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
      salt,
      hash: key,
    });
    await owner.credential.update({ where: { userId: user.id }, data: { passwordHash: legacy } });
    const before = await snapshot();
    expect(before.passwordHash).toBe(legacy);

    internalError(
      await client(failing).post('/auth/login', { email, password: PASSWORD, delivery: 'token' }),
    );
    expect(await snapshot()).toEqual(before);
    expect((await snapshot()).passwordHash).toBe(legacy); // still the weaker hash: the upgrade did not survive

    // The same sign-in with a working audit store succeeds AND upgrades, which proves the setup above was really exercising the upgrade.
    await client(normal).post('/auth/login', { email, password: PASSWORD, delivery: 'token' }).expect(200);
    const upgraded = (await snapshot()).passwordHash;
    expect(upgraded).not.toBe(legacy);
    expect(upgraded).toMatch(/^\$scrypt\$v=1\$ln=17,r=8,p=1,len=32\$/);
  });

  it('a REFUSED sign-in is the one place where the audit is best-effort: the response is unchanged', async () => {
    const { email } = await seed();
    const refused = await client(failing).post('/auth/login', {
      email,
      password: 'definitely the wrong one',
    });
    expect(refused.status).toBe(401);
    expect(apiErrorSchema.parse(refused.body).code).toBe('invalid_credentials');
  });
});

describe('email identity: spellings, concurrency and the shared failure budget (C2)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ allowRegistration: true });
  });
  afterAll(async () => {
    await app?.close();
  });

  /** The same address written six ways: upper case, padding, a tab and a line feed, NBSP and an ideographic space, a capital first letter. */
  const spellingsOf = (email: string) => [
    email,
    email.toUpperCase(),
    `  ${email}  `,
    `${CODE(0x9)}${email}${CODE(0xa)}`,
    `${CODE(0xa0)}${email}${CODE(0x3000)}`,
    `${email[0]?.toUpperCase()}${email.slice(1)}`,
  ];

  it('registering one address concurrently in six spellings creates exactly one account: one success, five email_taken, one row', async () => {
    const email = emailOf('race');
    const responses = await Promise.all(spellingsOf(email).map((spelling) => register(app, spelling)));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    for (const conflict of responses.filter((response) => response.status === 409))
      expect(apiErrorSchema.parse(conflict.body).code).toBe('email_taken');
    const winner = responses.find((response) => response.status === 201);
    expect(winner?.body.user.email).toBe(email); // the stored and returned form is the canonical one

    // Exactly one database row, in any spelling, and everything that belongs to it exists once.
    expect(await owner.user.count({ where: { email } })).toBe(1);
    expect(await owner.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })).toBe(1);
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    expect(await owner.credential.count({ where: { userId: user.id } })).toBe(1);
    expect(await owner.auditLog.count({ where: { action: 'auth.registered', resourceId: user.id } })).toBe(1);
  });

  it('sign-in works with every equivalent spelling of an existing address and always reports the canonical one', async () => {
    const email = emailOf('spelling');
    await register(app, email);
    const responses = await Promise.all(
      spellingsOf(email).map((spelling) =>
        client(app).post('/auth/login', { email: spelling, password: PASSWORD, delivery: 'token' }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    for (const response of responses) {
      const parsed = loginResponseSchema.parse(response.body);
      expect(parsed.user.email).toBe(email);
      SECRETS.push(parsed.token as string);
    }
    // Six spellings, one account, six sessions of that one account.
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    expect(await owner.session.count({ where: { userId: user.id } })).toBe(6);
  });

  it('shares ONE failure budget across equivalent spellings: it is exhausted by the tenth failure whichever spelling was used', async () => {
    const email = emailOf('budget');
    const other = emailOf('budget-other');
    await register(app, email);
    await register(app, other);
    const spellings = spellingsOf(email);
    const max = THROTTLE_RULES['signin-account'].max;

    for (let i = 0; i < max; i++) {
      const spelling = spellings[i % spellings.length] as string;
      expect(
        (await client(app).post('/auth/login', { email: spelling, password: `wrong ${i} password xx` }))
          .status,
      ).toBe(401);
    }
    // The budget is gone for EVERY spelling, even for the right password: a different spelling is not a second chance.
    for (const spelling of spellings) {
      const blocked = await client(app).post('/auth/login', { email: spelling, password: PASSWORD });
      expect(blocked.status, JSON.stringify(spelling)).toBe(429);
      expect(apiErrorSchema.parse(blocked.body).code).toBe('too_many_attempts');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Recorded once, for that account, as the account budget; and another account is untouched.
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    const throttled = await owner.auditLog.findMany({
      where: { action: 'auth.login_throttled', resourceId: user.id },
    });
    expect(throttled.map((row) => row.metadata)).toEqual([{ scope: 'account' }]);
    await client(app).post('/auth/login', { email: other, password: PASSWORD }).expect(200);
  });

  it('does not accept an address that only differs by something the application cannot canonicalize (non-ASCII stays a validation error)', async () => {
    const response = await register(app, `${CODE(0x130)}stanbul-${uid()}@example.com`);
    expect(response.status).toBe(400);
    expect(await owner.user.count({ where: { email: { contains: 'stanbul-' } } })).toBe(0);
  });
});

describe('a failed password change is audited (C6, real PostgreSQL and Redis)', () => {
  let normal: INestApplication;
  let failing: INestApplication;
  beforeAll(async () => {
    normal = await createApp({ allowRegistration: true });
    failing = await createApp({ allowRegistration: true, failingAudit: true });
  });
  afterAll(async () => {
    await Promise.all([normal?.close(), failing?.close()]);
  });

  async function signedInUser() {
    const email = emailOf('pwfail');
    await register(normal, email);
    const token = await loginToken(normal, email);
    const user = await owner.user.findUniqueOrThrow({ where: { email } });
    const failures = () =>
      owner.auditLog.findMany({
        where: { action: 'auth.password_change_failed', actorUserId: user.id },
        orderBy: { occurredAt: 'asc' },
      });
    return { email, token, user, failures };
  }
  const change = (app: INestApplication, token: string, currentPassword: string) =>
    client(app).post(
      '/me/password',
      { currentPassword, newPassword: 'a brand new long password' },
      bearer(token),
    );

  it('a wrong current password answers 422 and leaves one audit row with its reason, the user and a correlation id, and no secret', async () => {
    const { token, user, failures } = await signedInUser();
    const wrong = `wrong-current-${uid()}-password`;
    SECRETS.push(wrong, 'a brand new long password');

    const response = await change(normal, token, wrong);
    expect(response.status).toBe(422);
    expect(apiErrorSchema.parse(response.body).code).toBe('invalid_current_password');

    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: 'failure',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { reason: 'wrong_current_password' },
    });
    expect(rows[0]?.correlationId).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(wrong);
    await client(normal).get('/me', bearer(token)).expect(200); // the session was not touched
  });

  it('records the exhaustion of the password-change budget ONCE, answers 429 afterwards, and adds no further rows', async () => {
    const { token, failures } = await signedInUser();
    const max = THROTTLE_RULES['password-account'].max;
    for (let i = 0; i < max; i++)
      expect((await change(normal, token, `wrong ${i} current ${uid()}`)).status).toBe(422);

    const rows = await failures();
    expect(rows.map((row) => row.metadata)).toEqual([
      ...Array.from({ length: max }, () => ({ reason: 'wrong_current_password' })),
      { reason: 'rate_limited' },
    ]);

    for (let i = 0; i < 3; i++) {
      const refused = await change(normal, token, PASSWORD); // even the RIGHT password is refused now
      expect(refused.status).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(await failures()).toHaveLength(max + 1); // the refusals were not recorded
  });

  it('never changes a response when the audit store fails: 422 for a wrong password, 429 once the budget is used up', async () => {
    const { token, failures } = await signedInUser();
    const max = THROTTLE_RULES['password-account'].max;
    for (let i = 0; i < max; i++) {
      const response = await change(failing, token, `wrong ${i} current ${uid()}`);
      expect(response.status, `attempt ${i + 1}`).toBe(422); // including the attempt that exhausts the budget
      expect(apiErrorSchema.parse(response.body).code).toBe('invalid_current_password');
    }
    const refused = await change(failing, token, PASSWORD);
    expect(refused.status).toBe(429);
    expect(apiErrorSchema.parse(refused.body).code).toBe('too_many_attempts');
    expect(await failures()).toHaveLength(0); // nothing could be written, and nothing about it reached the caller
  });
});

describe('the audit trail', () => {
  it('is written in the same transaction as the change: if the audit append fails, the registration is rolled back', async () => {
    const app = await createApp({ allowRegistration: true, failingAudit: true });
    try {
      const email = emailOf('atomic');
      const before = await owner.user.count();
      const response = await register(app, email);
      expect(response.status).toBe(500);
      expect(apiErrorSchema.parse(response.body).code).toBe('internal_error');
      expect(await owner.user.count()).toBe(before);
      expect(await owner.credential.count({ where: { user: { email } } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('records every flow with a correlation id, only catalog actions, and no password, token or hash', async () => {
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(10);
    const catalog = new Set<string>(AUDIT_ACTIONS);
    for (const row of rows) {
      expect(catalog.has(row.action), row.action).toBe(true);
      expect(row.correlationId, `${row.action} has a correlation id`).toBeTruthy();
      expect(['success', 'failure']).toContain(row.result);
    }
    const serialized = JSON.stringify(rows);
    expect(SECRETS.length).toBeGreaterThan(10);
    for (const secret of SECRETS) expect(serialized, 'a secret in the audit trail').not.toContain(secret);
    expect(serialized).not.toContain('$scrypt$');
    // Failures are recorded only for accounts that exist.
    const failed = rows.filter((r) => r.action === 'auth.login_failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) expect(row.actorUserId).not.toBeNull();
  });

  it('never logs a password, a hash, a session token or a cookie through the application logger', async () => {
    const logged: unknown[][] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const)
      vi.spyOn(PinoLogger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    const app = await createApp({ allowRegistration: true });
    try {
      const email = emailOf('quiet');
      const secretPassword = `quiet-${randomUUID()}`;
      await register(app, email, secretPassword);
      const token = await loginToken(app, email, secretPassword);
      await client(app).post('/auth/login', { email, password: 'wrong-and-secret-xyz' });
      await client(app).post('/auth/login', { email: emailOf('who'), password: 'wrong-and-secret-xyz' });
      await client(app).post(
        '/me/password',
        { currentPassword: secretPassword, newPassword: 'new-secret-value-abc' },
        bearer(token),
      );
      const text = JSON.stringify(logged);
      for (const secret of [
        secretPassword,
        token,
        'wrong-and-secret-xyz',
        'new-secret-value-abc',
        '$scrypt$',
      ])
        expect(text, `"${secret}" in the logs`).not.toContain(secret);
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });
});
