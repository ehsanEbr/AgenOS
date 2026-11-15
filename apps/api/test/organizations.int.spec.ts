import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type OrganizationRole,
  apiErrorSchema,
  loginResponseSchema,
  memberSchema,
  organizationWithRoleSchema,
  paginatedSchema,
} from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { AUDIT_REPOSITORY } from '../src/modules/audit/application/audit-repository';
import { APP_CONFIG, type ApiConfig, loadApiConfig } from '../src/modules/config';
import { THROTTLE } from '../src/modules/identity/application/ports';
import { RedisThrottle } from '../src/modules/identity/infrastructure/redis-throttle';
import { RedisService } from '../src/modules/redis';
import { type IsolatedDatabase, adminDatabaseUrl, createIsolatedDatabase } from './support/isolated-database';

/*
 * Organizations and memberships end to end, in-process, against REAL PostgreSQL (a throwaway database with the real migrations, the
 * application connecting as the non-superuser API role) and REAL Redis. Requires `pnpm infra:up`.
 *
 * The central guarantees tested here: a caller can only ever reach organizations they belong to (404 otherwise, with no data and no side
 * effect), every role holds exactly the permissions of the matrix, only owners change ownership, an organization never loses its last
 * owner even under concurrent requests, and every change commits together with its audit events.
 */

const PASSWORD = 'correct horse battery staple';
const SECRETS: string[] = [PASSWORD];
const uid = () => randomBytes(4).toString('hex');
let addressCounter = 0;
const nextAddress = () =>
  `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter++ & 255}`;

const redisPrefix = `it:${uid()}:authn`;
let db: IsolatedDatabase;
let inspector: PrismaClient; // the migration role: only to INSPECT state and to change a user's status
let app: INestApplication;

function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/15';
  return parsed.toString();
}

async function createApp(options: { failingAudit?: boolean } = {}): Promise<INestApplication> {
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
  const created = (await builder.compile()).createNestApplication({ bufferLogs: true });
  configureApp(created, config);
  await created.init();
  return created;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** A signed-in (or anonymous, `token` undefined) caller of one application instance. */
function as(token: string | undefined, target: INestApplication = app) {
  const send = (method: Method, path: string, body?: unknown) => {
    const agent = request(target.getHttpServer());
    const req = agent[method](`/api/v1${path}`).set('X-Forwarded-For', nextAddress());
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body as object);
  };
  return {
    get: (path: string, _body?: unknown) => send('get', path),
    post: (path: string, body?: unknown) => send('post', path, body),
    patch: (path: string, body?: unknown) => send('patch', path, body),
    delete: (path: string, _body?: unknown) => send('delete', path),
  };
}

interface Person {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

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
  SECRETS.push(token);
  return { id: registered.body.user.id as string, email, token };
}

async function createOrganization(owner: Person, name = `Org ${uid()}`): Promise<string> {
  const response = await as(owner.token).post('/organizations', { name });
  expect(response.status).toBe(201);
  return organizationWithRoleSchema.parse(response.body).id;
}

async function addMember(actor: Person, organizationId: string, who: Person, role: OrganizationRole) {
  const response = await as(actor.token).post(`/organizations/${organizationId}/members`, {
    email: who.email,
    role,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

const rolesIn = async (organizationId: string) =>
  Object.fromEntries(
    (await inspector.membership.findMany({ where: { organizationId } })).map((row) => [row.userId, row.role]),
  );
const ownersIn = async (organizationId: string) =>
  inspector.membership.count({ where: { organizationId, role: 'owner' } });
const auditFor = (organizationId: string) =>
  inspector.auditLog.findMany({ where: { organizationId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
/**
 * The actions of some events, sorted. `occurred_at` is the START of the transaction, so the events of one transaction share it and have
 * no defined order among themselves: compare them as a set, never as a sequence.
 */
const actionsOf = (events: { action: string }[]) => events.map((event) => event.action).sort();
const errorOf = (body: unknown) => apiErrorSchema.parse(body);

beforeAll(async () => {
  db = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
  await db.applyMigrations();
  inspector = new PrismaClient({ datasourceUrl: db.urlFor('migrate') });
  app = await createApp();
}, 120_000);

afterAll(async () => {
  const redis = app?.get(RedisService).client;
  if (redis) {
    const keys = await redis.keys(`${redisPrefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await app?.close();
  await inspector?.$disconnect();
  await db?.drop();
});

describe('creating, listing, reading and renaming organizations', () => {
  it('makes the creator the owner, answers with their role, and records the three audit events in one transaction', async () => {
    const ada = await signUp('ada');
    const response = await as(ada.token).post('/organizations', { name: '  Analytical Engines  ' });
    expect(response.status).toBe(201);
    const created = organizationWithRoleSchema.parse(response.body);
    expect(created).toMatchObject({ name: 'Analytical Engines', role: 'owner' });

    expect(await rolesIn(created.id)).toEqual({ [ada.id]: 'owner' });
    const events = await auditFor(created.id);
    expect(actionsOf(events)).toEqual([
      'membership.added',
      'organization.created',
      'organization.owner_granted',
    ]);
    expect(events.every((event) => event.actorUserId === ada.id && event.result === 'success')).toBe(true);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1); // one request
    expect(events.find((event) => event.action === 'membership.added')?.metadata).toEqual({
      userId: ada.id,
      role: 'owner',
    });
  });

  it('lists only the organizations the caller belongs to, with their own role, paginated', async () => {
    const [grace, linus] = [await signUp('grace'), await signUp('linus')];
    const [first, second, other] = [
      await createOrganization(grace, 'A'),
      await createOrganization(grace, 'B'),
      await createOrganization(linus, 'Not for grace'),
    ];
    await addMember(linus, other, grace, 'viewer');

    const schema = paginatedSchema(organizationWithRoleSchema);
    const all = schema.parse((await as(grace.token).get('/organizations')).body);
    expect(all.page).toEqual({ limit: 20, offset: 0, total: 3 });
    expect(all.items.map((item) => [item.id, item.role]).sort()).toEqual(
      [
        [first, 'owner'],
        [second, 'owner'],
        [other, 'viewer'],
      ].sort(),
    );

    const page = schema.parse((await as(grace.token).get('/organizations?limit=1&offset=1')).body);
    expect(page.items).toHaveLength(1);
    expect(page.page).toEqual({ limit: 1, offset: 1, total: 3 });

    const linusOnly = schema.parse((await as(linus.token).get('/organizations')).body);
    expect(linusOnly.items.map((item) => item.id)).not.toContain(first);
    expect(linusOnly.page.total).toBe(1);
  });

  it('renames for an owner, audits the change by field name only, and does not audit a rename to the same name', async () => {
    const owner = await signUp('owner');
    const id = await createOrganization(owner, 'Before');
    const renamed = await as(owner.token).patch(`/organizations/${id}`, { name: 'After' });
    expect(renamed.status).toBe(200);
    expect(organizationWithRoleSchema.parse(renamed.body)).toMatchObject({ name: 'After', role: 'owner' });
    expect((await as(owner.token).get(`/organizations/${id}`)).body.name).toBe('After');

    await as(owner.token).patch(`/organizations/${id}`, { name: 'After' }).expect(200);
    const updates = (await auditFor(id)).filter((event) => event.action === 'organization.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.metadata).toEqual({ changedFields: ['name'] });
    expect(JSON.stringify(updates)).not.toContain('After');
  });

  it('rejects invalid input with 400 and creates nothing', async () => {
    const user = await signUp('validator');
    const before = await inspector.organization.count();
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 5 }])
      expect((await as(user.token).post('/organizations', body)).status).toBe(400);
    expect(await inspector.organization.count()).toBe(before);
  });
});

describe('tenant isolation: another organization is indistinguishable from none', () => {
  let alice: Person; // owner of organization A
  let bob: Person; // owner of organization B (a member of ANOTHER organization)
  let frank: Person; // belongs to no organization
  let dave: Person; // a member of A: the target of the member routes
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    [alice, bob, frank, dave] = [
      await signUp('alice'),
      await signUp('bob'),
      await signUp('frank'),
      await signUp('dave'),
    ];
    orgA = await createOrganization(alice, 'Organization A secret name');
    orgB = await createOrganization(bob, 'Organization B');
    await addMember(alice, orgA, dave, 'member');
  });

  const routes = (organization: string, target: string) =>
    [
      ['get', `/organizations/${organization}`, undefined],
      ['patch', `/organizations/${organization}`, { name: 'Hijacked' }],
      ['get', `/organizations/${organization}/members`, undefined],
      ['post', `/organizations/${organization}/members`, { email: 'someone@example.com', role: 'member' }],
      ['patch', `/organizations/${organization}/members/${target}`, { role: 'viewer' }],
      ['delete', `/organizations/${organization}/members/${target}`, undefined],
    ] as const;

  it('answers 404 organization_not_found to a member of another organization and to a user with none: same status, code, message and shape', async () => {
    const bodies: Record<string, unknown[]> = {};
    for (const [method, path, body] of routes(orgA, dave.id))
      for (const [label, caller] of [
        ['bob', bob],
        ['frank', frank],
      ] as const) {
        const response = await as(caller.token)[method](path, body);
        expect(response.status, `${label} ${method} ${path}`).toBe(404);
        const error = errorOf(response.body);
        expect(error.code).toBe('organization_not_found');
        (bodies[`${method} ${path}`] ??= []).push({ code: error.code, message: error.message });
        expect(JSON.stringify(response.body)).not.toMatch(/secret name|alice|dave|Hijacked/i);
      }
    for (const pair of Object.values(bodies)) expect(pair[0]).toEqual(pair[1]);
  });

  it('answers the same 404 for an organization that does not exist and for a malformed id', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])
      for (const [method, path, body] of routes(id, dave.id)) {
        const response = await as(alice.token)[method](path, body);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(errorOf(response.body).code).toBe('organization_not_found');
      }
  });

  it('answers 401 without a session on every organization route', async () => {
    for (const [method, path, body] of [
      ...routes(orgA, dave.id),
      ['get', '/organizations', undefined] as const,
      ['post', '/organizations', { name: 'x' }] as const,
    ]) {
      const response = await as(undefined)[method](path, body);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(errorOf(response.body).code).toBe('unauthenticated');
    }
  });

  it('changed nothing: the memberships, the name and the audit trail of organization A are untouched by the refused requests', async () => {
    expect(await rolesIn(orgA)).toEqual({ [alice.id]: 'owner', [dave.id]: 'member' });
    expect((await inspector.organization.findUniqueOrThrow({ where: { id: orgA } })).name).toBe(
      'Organization A secret name',
    );
    expect(actionsOf(await auditFor(orgA))).toEqual([
      'membership.added', // alice, creating the organization
      'membership.added', // dave
      'organization.created',
      'organization.owner_granted',
    ]);
  });

  it('does not list or reveal organization A to bob, even by member id', async () => {
    const mine = paginatedSchema(organizationWithRoleSchema).parse(
      (await as(bob.token).get('/organizations')).body,
    );
    expect(mine.items.map((item) => item.id)).toEqual([orgB]);
    // bob names alice's organization and a real member of it while acting in his own: still nothing
    const crossed = await as(bob.token).patch(`/organizations/${orgB}/members/${dave.id}`, { role: 'admin' });
    expect(crossed.status).toBe(404);
    expect(errorOf(crossed.body).code).toBe('member_not_found');
    expect(await rolesIn(orgA)).toMatchObject({ [dave.id]: 'member' });
  });
});

describe('the role matrix over HTTP', () => {
  let owner: Person;
  let admin: Person;
  let member: Person;
  let viewer: Person;
  let org: string;

  beforeAll(async () => {
    [owner, admin, member, viewer] = [
      await signUp('mowner'),
      await signUp('madmin'),
      await signUp('mmember'),
      await signUp('mviewer'),
    ];
    org = await createOrganization(owner);
    await addMember(owner, org, admin, 'admin');
    await addMember(owner, org, member, 'member');
    await addMember(owner, org, viewer, 'viewer');
  });

  const readers = () => [owner, admin, member, viewer];

  it('lets every member read the organization and its members, with their emails', async () => {
    for (const person of readers()) {
      expect((await as(person.token).get(`/organizations/${org}`)).status).toBe(200);
      const members = paginatedSchema(memberSchema).parse(
        (await as(person.token).get(`/organizations/${org}/members`)).body,
      );
      expect(members.page.total).toBe(4);
      expect(members.items.map((item) => item.email).sort()).toEqual(
        [owner, admin, member, viewer].map((p) => p.email).sort(),
      );
      expect(members.items.find((item) => item.userId === admin.id)?.role).toBe('admin');
    }
  });

  it('renames only for owner and admin', async () => {
    const expected = new Map([
      [owner, 200],
      [admin, 200],
      [member, 403],
      [viewer, 403],
    ]);
    for (const [person, status] of expected) {
      const response = await as(person.token).patch(`/organizations/${org}`, { name: `By ${uid()}` });
      expect(response.status).toBe(status);
      if (status === 403) expect(errorOf(response.body).code).toBe('forbidden');
    }
  });

  it('adds members only for owner and admin', async () => {
    const outcomes = new Map<Person, number>();
    for (const person of [owner, admin, member, viewer]) {
      const newcomer = await signUp('newcomer');
      const response = await as(person.token).post(`/organizations/${org}/members`, {
        email: newcomer.email,
        role: 'viewer',
      });
      outcomes.set(person, response.status);
      expect(Object.keys(await rolesIn(org)).includes(newcomer.id)).toBe(response.status === 201);
    }
    expect([...outcomes.values()]).toEqual([201, 201, 403, 403]);
  });

  it('changes and removes other members only for owner and admin', async () => {
    const attempts = [
      [owner, 200, 204],
      [admin, 200, 204],
      [member, 403, 403],
      [viewer, 403, 403],
    ] as const;
    for (const [person, changeStatus, removeStatus] of attempts) {
      const target = await signUp('target');
      await addMember(owner, org, target, 'member');
      const change = await as(person.token).patch(`/organizations/${org}/members/${target.id}`, {
        role: 'viewer',
      });
      expect(change.status).toBe(changeStatus);
      expect((await rolesIn(org))[target.id]).toBe(changeStatus === 200 ? 'viewer' : 'member');
      const removal = await as(person.token).delete(`/organizations/${org}/members/${target.id}`);
      expect(removal.status).toBe(removeStatus);
      expect(target.id in (await rolesIn(org))).toBe(removeStatus !== 204);
    }
  });

  it('lets anyone leave by removing themselves, viewers included', async () => {
    const leaver = await signUp('leaver');
    await addMember(owner, org, leaver, 'viewer');
    expect((await as(leaver.token).delete(`/organizations/${org}/members/${leaver.id}`)).status).toBe(204);
    expect(leaver.id in (await rolesIn(org))).toBe(false);
    // ...and is then a stranger to the organization.
    expect((await as(leaver.token).get(`/organizations/${org}`)).status).toBe(404);
  });

  it('applies a role change to the very next request: nothing about the role is cached', async () => {
    const colleague = await signUp('colleague');
    await addMember(owner, org, colleague, 'admin');
    await as(colleague.token).patch(`/organizations/${org}`, { name: 'Colleague was here' }).expect(200);

    await as(owner.token)
      .patch(`/organizations/${org}/members/${colleague.id}`, { role: 'viewer' })
      .expect(200);
    expect((await as(colleague.token).patch(`/organizations/${org}`, { name: 'Again' })).status).toBe(403);

    await as(owner.token).delete(`/organizations/${org}/members/${colleague.id}`).expect(204);
    expect((await as(colleague.token).get(`/organizations/${org}`)).status).toBe(404);
  });
});

describe('ownership belongs to owners', () => {
  it('stops an admin from creating, changing or removing an owner, and from promoting themselves', async () => {
    const [owner, admin, member, heir] = [
      await signUp('o'),
      await signUp('a'),
      await signUp('m'),
      await signUp('h'),
    ];
    const org = await createOrganization(owner);
    await addMember(owner, org, admin, 'admin');
    await addMember(owner, org, member, 'member');
    const before = await rolesIn(org);
    const events = (await auditFor(org)).length;

    const attempts = [
      as(admin.token).post(`/organizations/${org}/members`, { email: heir.email, role: 'owner' }),
      as(admin.token).patch(`/organizations/${org}/members/${member.id}`, { role: 'owner' }),
      as(admin.token).patch(`/organizations/${org}/members/${admin.id}`, { role: 'owner' }),
      as(admin.token).patch(`/organizations/${org}/members/${owner.id}`, { role: 'viewer' }),
      as(admin.token).delete(`/organizations/${org}/members/${owner.id}`),
    ];
    for (const attempt of attempts) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(errorOf(response.body).code).toBe('forbidden');
    }
    expect(await rolesIn(org)).toEqual(before);
    expect((await auditFor(org)).length).toBe(events);
  });

  it('lets an owner hand ownership out and take it away, recording the grant and the revocation in addition', async () => {
    const [founder, partner] = [await signUp('founder'), await signUp('partner')];
    const org = await createOrganization(founder);
    await addMember(founder, org, partner, 'owner');
    await as(founder.token)
      .patch(`/organizations/${org}/members/${partner.id}`, { role: 'admin' })
      .expect(200);
    await as(founder.token)
      .patch(`/organizations/${org}/members/${partner.id}`, { role: 'owner' })
      .expect(200);
    await as(partner.token).delete(`/organizations/${org}/members/${founder.id}`).expect(204);

    const events = await auditFor(org);
    expect(actionsOf(events)).toEqual([
      'membership.added', // founder, creating the organization
      'membership.added', // partner, as owner
      'membership.removed', // partner removes founder
      'membership.role_changed', // owner -> admin
      'membership.role_changed', // admin -> owner
      'organization.created',
      'organization.owner_granted', // founder
      'organization.owner_granted', // partner added as owner
      'organization.owner_granted', // partner admin -> owner
      'organization.owner_revoked', // partner owner -> admin
      'organization.owner_revoked', // founder removed
    ]);
    const changes = events
      .filter((event) => event.action === 'membership.role_changed')
      .map((event) => event.metadata);
    expect(changes).toContainEqual({ userId: partner.id, previousRole: 'owner', role: 'admin' });
    expect(changes).toContainEqual({ userId: partner.id, previousRole: 'admin', role: 'owner' });
    expect(events.find((event) => event.action === 'membership.removed')?.metadata).toEqual({
      userId: founder.id,
      role: 'owner',
      self: false,
    });
    expect(
      events.filter((event) => event.action === 'organization.owner_revoked').map((event) => event.metadata),
    ).toEqual(expect.arrayContaining([{ userId: partner.id }, { userId: founder.id }]));
    expect(events.every((event) => event.organizationId === org)).toBe(true);
    expect(await rolesIn(org)).toEqual({ [partner.id]: 'owner' });
  });

  it('does not audit a role change to the role the member already has', async () => {
    const [owner, member] = [await signUp('o2'), await signUp('m2')];
    const org = await createOrganization(owner);
    await addMember(owner, org, member, 'member');
    const events = (await auditFor(org)).length;
    await as(owner.token).patch(`/organizations/${org}/members/${member.id}`, { role: 'member' }).expect(200);
    expect((await auditFor(org)).length).toBe(events);
  });
});

describe('adding a member by email', () => {
  it('matches the address as people type it, and answers 404 / 409 for unknown, disabled and existing members', async () => {
    const [owner, guest, gone] = [await signUp('adder'), await signUp('guest'), await signUp('gone')];
    const org = await createOrganization(owner);
    const members = `/organizations/${org}/members`;

    const unknown = await as(owner.token).post(members, { email: 'nobody-here@example.com', role: 'member' });
    expect([unknown.status, errorOf(unknown.body).code]).toEqual([404, 'user_not_found']);

    await inspector.user.update({ where: { id: gone.id }, data: { status: 'disabled' } });
    const disabled = await as(owner.token).post(members, { email: gone.email, role: 'member' });
    expect([disabled.status, errorOf(disabled.body).code]).toEqual([404, 'user_not_found']);

    const added = await as(owner.token).post(members, {
      email: `  ${guest.email.toUpperCase()} `,
      role: 'viewer',
    });
    expect(added.status).toBe(201);
    expect(memberSchema.parse(added.body)).toMatchObject({
      userId: guest.id,
      email: guest.email,
      role: 'viewer',
    });

    const again = await as(owner.token).post(members, { email: guest.email, role: 'admin' });
    expect([again.status, errorOf(again.body).code]).toEqual([409, 'already_member']);
    expect((await rolesIn(org))[guest.id]).toBe('viewer');
  });

  it('adds a user once when the same request arrives twice at the same time', async () => {
    const [owner, guest] = [await signUp('twice'), await signUp('twiceguest')];
    const org = await createOrganization(owner);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        as(owner.token).post(`/organizations/${org}/members`, { email: guest.email, role: 'member' }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await inspector.membership.count({ where: { organizationId: org, userId: guest.id } })).toBe(1);
    expect((await auditFor(org)).filter((event) => event.action === 'membership.added')).toHaveLength(2); // the founder and the guest
  });

  it('validates the body and the path', async () => {
    const owner = await signUp('validator2');
    const org = await createOrganization(owner);
    for (const body of [
      {},
      { email: 'not-an-email', role: 'member' },
      { email: 'a@example.com', role: 'root' },
      { email: 'a@example.com' },
    ])
      expect((await as(owner.token).post(`/organizations/${org}/members`, body)).status).toBe(400);
    expect(
      (await as(owner.token).patch(`/organizations/${org}/members/not-a-uuid`, { role: 'member' })).status,
    ).toBe(400);
    expect(
      (await as(owner.token).patch(`/organizations/${org}/members/${owner.id}`, { role: 'sovereign' }))
        .status,
    ).toBe(400);
    expect(
      (await as(owner.token).patch(`/organizations/${org}/members/${randomUUID()}`, { role: 'member' }))
        .status,
    ).toBe(404);
  });
});

describe('an organization always keeps an owner', () => {
  it('refuses to demote, remove or let the only owner leave, and changes nothing', async () => {
    const owner = await signUp('sole');
    const org = await createOrganization(owner);
    const events = (await auditFor(org)).length;

    for (const attempt of [
      as(owner.token).patch(`/organizations/${org}/members/${owner.id}`, { role: 'admin' }),
      as(owner.token).delete(`/organizations/${org}/members/${owner.id}`),
    ]) {
      const response = await attempt;
      expect([response.status, errorOf(response.body).code]).toEqual([409, 'last_owner']);
    }
    expect(await rolesIn(org)).toEqual({ [owner.id]: 'owner' });
    expect((await auditFor(org)).length).toBe(events);
  });

  it('allows the same actions as soon as another owner exists', async () => {
    const [first, second] = [await signUp('first'), await signUp('second')];
    const org = await createOrganization(first);
    await addMember(first, org, second, 'owner');
    await as(first.token).patch(`/organizations/${org}/members/${first.id}`, { role: 'member' }).expect(200);
    // now `second` is the only owner again
    const response = await as(second.token).delete(`/organizations/${org}/members/${second.id}`);
    expect([response.status, errorOf(response.body).code]).toEqual([409, 'last_owner']);
    expect(await ownersIn(org)).toBe(1);
  });

  describe('under concurrent requests (PostgreSQL row locks)', () => {
    const ROUNDS = 8;

    async function race(
      label: string,
      start: (
        a: Person,
        b: Person,
        org: string,
      ) => [PromiseLike<{ status: number }>, PromiseLike<{ status: number }>],
      expectedStatuses: number[][],
    ) {
      const [a, b] = [await signUp(`${label}a`), await signUp(`${label}b`)];
      for (let round = 0; round < ROUNDS; round += 1) {
        const org = await createOrganization(a);
        await addMember(a, org, b, 'owner');
        const results = await Promise.all(start(a, b, org));
        const statuses = results.map((result) => result.status).sort();
        expect(expectedStatuses, `${label} round ${round}: ${statuses}`).toContainEqual(statuses);
        expect(await ownersIn(org), `${label} round ${round}`).toBeGreaterThanOrEqual(1);
      }
    }

    it('lets only one of two owners demote themselves', () =>
      race(
        'demote',
        (a, b, org) => [
          as(a.token).patch(`/organizations/${org}/members/${a.id}`, { role: 'member' }),
          as(b.token).patch(`/organizations/${org}/members/${b.id}`, { role: 'member' }),
        ],
        [[200, 409]],
      ));

    it('lets only one of two owners leave', () =>
      race(
        'leave',
        (a, b, org) => [
          as(a.token).delete(`/organizations/${org}/members/${a.id}`),
          as(b.token).delete(`/organizations/${org}/members/${b.id}`),
        ],
        [[204, 409]],
      ));

    it('lets only one of two owners remove the other (the second finds themselves no longer a member)', () =>
      race(
        'remove',
        (a, b, org) => [
          as(a.token).delete(`/organizations/${org}/members/${b.id}`),
          as(b.token).delete(`/organizations/${org}/members/${a.id}`),
        ],
        [[204, 404]],
      ));

    it('lets only one owner demote the other while the other demotes them (the loser is no longer an owner)', () =>
      race(
        'swap',
        (a, b, org) => [
          as(a.token).patch(`/organizations/${org}/members/${b.id}`, { role: 'member' }),
          as(b.token).patch(`/organizations/${org}/members/${a.id}`, { role: 'member' }),
        ],
        [[200, 403]],
      ));
  });
});

describe('every change commits together with its audit events', () => {
  it('rolls the change back when the audit trail cannot be written', async () => {
    const [owner, guest, member] = [
      await signUp('atomic'),
      await signUp('atomicguest'),
      await signUp('atomicmember'),
    ];
    const org = await createOrganization(owner, 'Before');
    await addMember(owner, org, member, 'member');
    const broken = await createApp({ failingAudit: true });
    try {
      const organizations = await inspector.organization.count();
      const events = await inspector.auditLog.count();
      const memberships = await inspector.membership.count();

      const create = await as(owner.token, broken).post('/organizations', { name: 'Never' });
      const rename = await as(owner.token, broken).patch(`/organizations/${org}`, { name: 'Never either' });
      const add = await as(owner.token, broken).post(`/organizations/${org}/members`, {
        email: guest.email,
        role: 'viewer',
      });
      const change = await as(owner.token, broken).patch(`/organizations/${org}/members/${member.id}`, {
        role: 'admin',
      });
      const remove = await as(owner.token, broken).delete(`/organizations/${org}/members/${member.id}`);
      for (const response of [create, rename, add, change, remove]) {
        expect(response.status).toBe(500);
        expect(JSON.stringify(response.body)).not.toMatch(/audit store/);
      }

      expect(await inspector.organization.count()).toBe(organizations);
      expect(await inspector.membership.count()).toBe(memberships);
      expect(await inspector.auditLog.count()).toBe(events);
      expect((await inspector.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe('Before');
      expect((await rolesIn(org))[member.id]).toBe('member');
    } finally {
      await broken.close();
    }
  });
});

describe('nothing secret reaches the audit trail', () => {
  it('holds no password or session token from any request of this file', async () => {
    const dump = JSON.stringify(await inspector.auditLog.findMany());
    expect(dump.length).toBeGreaterThan(100);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
    const organizationEvents = await inspector.auditLog.findMany({
      where: { organizationId: { not: null } },
    });
    for (const event of organizationEvents)
      expect(
        Object.keys(event.metadata as object).every((key) =>
          ['changedFields', 'userId', 'role', 'previousRole', 'self'].includes(key),
        ),
      ).toBe(true);
  });
});
