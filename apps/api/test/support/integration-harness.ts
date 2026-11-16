import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { expect } from 'vitest';
import {
  type AuditEventInput,
  type OrganizationRole,
  loginResponseSchema,
  organizationWithRoleSchema,
} from '@agentos/contracts';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { AUDIT_REPOSITORY, type AuditEntry } from '../../src/modules/audit/application/audit-repository';
import { PrismaAuditRepository } from '../../src/modules/audit/infrastructure/prisma-audit.repository';
import { APP_CONFIG, type ApiConfig, loadApiConfig } from '../../src/modules/config';
import { THROTTLE } from '../../src/modules/identity/application/ports';
import { RedisThrottle } from '../../src/modules/identity/infrastructure/redis-throttle';
import { RedisService } from '../../src/modules/redis';
import { type IsolatedDatabase, adminDatabaseUrl, createIsolatedDatabase } from './isolated-database';

/*
 * A shared harness for the HTTP integration suites of the organizations and projects modules: a throwaway database with the real
 * migrations, the application connecting as the non-superuser API role, real Redis for the rate limiter (own key prefix), and helpers to
 * register people, sign them in and call the API as them. Requires `pnpm infra:up`.
 */

export const PASSWORD = 'correct horse battery staple';
export const uid = () => randomBytes(4).toString('hex');

let addressCounter = 0;
/** A distinct client address per call (the app trusts one proxy hop), so per-address limits never leak between tests. */
const nextAddress = () =>
  `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter++ & 255}`;

function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/15';
  return parsed.toString();
}

export interface AppOptions {
  /** Make every audit append fail, to prove a change and its events commit together. */
  failingAudit?: boolean;
  /** Called before every audit append (it may wait): used to hold a request in flight at a known point of its transaction. */
  beforeAudit?: (entry: AuditEntry) => Promise<void>;
  /** Replace providers (for example to prove a startup failure). */
  override?: (
    builder: ReturnType<typeof Test.createTestingModule>,
  ) => ReturnType<typeof Test.createTestingModule>;
}

export type Method = 'get' | 'post' | 'patch' | 'delete';

export interface Person {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

export interface Harness {
  readonly db: IsolatedDatabase;
  /** The migration role: only to INSPECT state, to seed rows the API cannot, and to change a user's status. */
  readonly inspector: PrismaClient;
  readonly app: INestApplication;
  /** Every password and token this harness handled: none may ever appear in the audit trail. */
  readonly secrets: string[];
  createApp(options?: AppOptions): Promise<INestApplication>;
  /** Call the API as a signed-in person (or anonymously, `token` undefined) on one application instance. */
  as(
    token: string | undefined,
    target?: INestApplication,
  ): {
    get(path: string, body?: unknown): request.Test;
    post(path: string, body?: unknown): request.Test;
    patch(path: string, body?: unknown): request.Test;
    delete(path: string, body?: unknown): request.Test;
  };
  signUp(name: string): Promise<Person>;
  createOrganization(owner: Person, name?: string): Promise<string>;
  addOrganizationMember(
    actor: Person,
    organizationId: string,
    who: Person,
    role: OrganizationRole,
  ): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const redisPrefix = `it:${uid()}:authn`;
  const secrets: string[] = [PASSWORD];
  const db = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
  await db.applyMigrations();
  const inspector = new PrismaClient({ datasourceUrl: db.urlFor('migrate') });
  const opened: INestApplication[] = [];

  async function createApp(options: AppOptions = {}): Promise<INestApplication> {
    const base = loadApiConfig();
    const config: ApiConfig = {
      ...base,
      DATABASE_URL: db.urlFor('api'),
      REDIS_URL: isolatedRedisUrl(base.REDIS_URL),
      WEB_ORIGIN: 'http://localhost:5173',
      TRUST_PROXY_HOPS: 1,
      AUTH_ALLOW_REGISTRATION: true,
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
    else if (options.beforeAudit) {
      const real = new PrismaAuditRepository();
      const hook = options.beforeAudit;
      builder = builder.overrideProvider(AUDIT_REPOSITORY).useValue({
        append: async (entry: AuditEntry, tx: Parameters<PrismaAuditRepository['append']>[1]) => {
          await hook(entry);
          return real.append(entry, tx);
        },
      });
    }
    if (options.override) builder = options.override(builder);
    const created = (await builder.compile()).createNestApplication({ bufferLogs: true });
    configureApp(created, config);
    await created.init();
    opened.push(created);
    return created;
  }

  const app = await createApp();

  const as: Harness['as'] = (token, target = app) => {
    const send = (method: Method, path: string, body?: unknown) => {
      const agent = request(target.getHttpServer());
      const req = agent[method](`/api/v1${path}`).set('X-Forwarded-For', nextAddress());
      if (token) req.set('Authorization', `Bearer ${token}`);
      return body === undefined ? req : req.send(body as object);
    };
    return {
      get: (path, _body) => send('get', path),
      post: (path, body) => send('post', path, body),
      patch: (path, body) => send('patch', path, body),
      delete: (path, _body) => send('delete', path),
    };
  };

  async function signUp(name: string): Promise<Person> {
    const email = `${name}-${uid()}@example.com`;
    const registered = await as(undefined).post('/auth/register', {
      email,
      displayName: name,
      password: PASSWORD,
    });
    expect(registered.status).toBe(201);
    const login = await as(undefined).post('/auth/login', { email, password: PASSWORD, delivery: 'token' });
    const token = loginResponseSchema.parse(login.body).token as string;
    secrets.push(token);
    return { id: registered.body.user.id as string, email, token };
  }

  return {
    db,
    inspector,
    app,
    secrets,
    createApp,
    as,
    signUp,
    async createOrganization(owner, name = `Org ${uid()}`) {
      const response = await as(owner.token).post('/organizations', { name });
      expect(response.status).toBe(201);
      return organizationWithRoleSchema.parse(response.body).id;
    },
    async addOrganizationMember(actor, organizationId, who, role) {
      const response = await as(actor.token).post(`/organizations/${organizationId}/members`, {
        email: who.email,
        role,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    },
    async close() {
      const redis = app.get(RedisService).client;
      const keys = await redis.keys(`${redisPrefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      for (const created of opened) await created.close().catch(() => undefined);
      await inspector.$disconnect();
      await db.drop();
    },
  };
}

/** The actions of some audit rows, sorted. Events of one transaction share `occurred_at`: compare them as a set, never as a sequence. */
export const actionsOf = (events: { action: string }[]) => events.map((event) => event.action).sort();

export type { AuditEventInput };
