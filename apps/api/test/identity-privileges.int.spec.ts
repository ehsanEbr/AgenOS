import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeEmail, emailSchema } from '@agentos/contracts';
import type { DatabaseClient } from '../src/modules/database';
import { PrismaAuditRepository } from '../src/modules/audit/infrastructure/prisma-audit.repository';
import { type IsolatedDatabase, adminDatabaseUrl, createIsolatedDatabase } from './support/isolated-database';

/*
 * Database roles and the audit trail's append-only protection, exercised with the ROLES the application really uses (ADR-0010):
 *
 *   agentos_migrate   owns the schemas and tables and applied the migrations below (not a superuser)
 *   agentos_api       what the API connects as: not a superuser, owns nothing, gets only what the migrations granted
 *
 * No statement under test runs as a superuser: the superuser only creates and drops the throwaway database.
 * Requires the Compose stack with the roles provisioned (`pnpm infra:up`).
 */

let db: IsolatedDatabase;
let api: PrismaClient; // the application's login role
let owner: PrismaClient; // the migration role: owns every table

const uid = () => randomUUID().slice(0, 8);
const run = (client: PrismaClient, sql: string) => client.$executeRawUnsafe(sql);
const query = <T>(client: PrismaClient, sql: string) => client.$queryRawUnsafe<T[]>(sql);
const denied = /permission denied/i;
const appendOnly = /audit_log is append-only/i;

async function insertAuditRowAsApi(): Promise<string> {
  const id = randomUUID();
  await new PrismaAuditRepository().append(
    {
      id,
      action: 'auth.logout',
      resourceType: 'session',
      result: 'success',
      metadata: {},
      actorUserId: null,
      organizationId: null,
      projectId: null,
      resourceId: null,
      correlationId: 'privileges-test',
    },
    api as DatabaseClient,
  );
  return id;
}

beforeAll(async () => {
  db = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
  await db.applyMigrations();
  api = new PrismaClient({ datasourceUrl: db.urlFor('api') });
  owner = new PrismaClient({ datasourceUrl: db.urlFor('migrate') });
});

afterAll(async () => {
  await Promise.all([api?.$disconnect(), owner?.$disconnect()]);
  await db?.drop();
});

describe('the application role', () => {
  it('is a real, non-superuser login that owns nothing and can create nothing', async () => {
    const [who] = await query<{
      user: string;
      super: boolean;
      createdb: boolean;
      createrole: boolean;
      bypassrls: boolean;
    }>(
      api,
      `SELECT current_user AS "user", r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(who).toEqual({
      user: 'agentos_api',
      super: false,
      createdb: false,
      createrole: false,
      bypassrls: false,
    });

    const owned = await query<{ n: bigint }>(
      api,
      `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = current_user`,
    );
    expect(Number(owned[0]?.n)).toBe(0);
    const schemasOwned = await query<{ n: bigint }>(
      api,
      `SELECT count(*) AS n FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = current_user`,
    );
    expect(Number(schemasOwned[0]?.n)).toBe(0);

    for (const statement of [
      'CREATE TABLE public.nope (i int)',
      'CREATE TABLE identity.nope (i int)',
      'CREATE TABLE security.nope (i int)',
      'CREATE SCHEMA nope',
      'CREATE ROLE nope',
      'CREATE DATABASE nope',
    ])
      await expect(run(api, statement), statement).rejects.toThrow(denied);
  });

  it('the schema and the tables belong to the migration role, which is not a superuser either', async () => {
    const tables = await query<{ owner: string }>(
      owner,
      `SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ('identity', 'security')`,
    );
    expect(tables).toEqual([{ owner: 'agentos_migrate' }]);
    const [role] = await query<{ super: boolean; createrole: boolean }>(
      owner,
      `SELECT rolsuper AS super, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ super: false, createrole: false });
  });

  it('holds exactly the privileges the Identity module needs, and no others (least privilege)', async () => {
    const grants = await query<{ table: string; privilege: string }>(
      owner,
      `SELECT table_schema || '.' || table_name AS "table", privilege_type AS privilege
         FROM information_schema.role_table_grants
        WHERE grantee = 'agentos_app' ORDER BY 1, 2`,
    );
    expect(grants).toEqual([
      { table: 'identity.credential', privilege: 'INSERT' },
      { table: 'identity.credential', privilege: 'SELECT' },
      { table: 'identity.credential', privilege: 'UPDATE' },
      { table: 'identity.session', privilege: 'INSERT' },
      { table: 'identity.session', privilege: 'SELECT' },
      { table: 'identity.session', privilege: 'UPDATE' },
      { table: 'identity.user', privilege: 'INSERT' },
      { table: 'identity.user', privilege: 'SELECT' },
      { table: 'identity.user', privilege: 'UPDATE' },
      // The audit trail: INSERT and nothing else. In particular NO SELECT.
      { table: 'security.audit_log', privilege: 'INSERT' },
    ]);
  });

  it('cannot delete or truncate identity data (users and sessions are never deleted in this phase)', async () => {
    for (const statement of [
      'DELETE FROM identity."user"',
      'DELETE FROM identity.session',
      'DELETE FROM identity.credential',
      'TRUNCATE identity."user" CASCADE',
    ])
      await expect(run(api, statement), statement).rejects.toThrow(denied);
  });
});

describe('the audit trail is append-only', () => {
  it('the application role can append without any SELECT privilege (the repository needs no RETURNING)', async () => {
    const id = await insertAuditRowAsApi();
    const rows = await query<{ id: string; correlation_id: string }>(
      owner,
      `SELECT id, correlation_id FROM security.audit_log WHERE id = '${id}'`,
    );
    expect(rows).toEqual([{ id, correlation_id: 'privileges-test' }]);
  });

  it('Prisma create (which asks for the row back with RETURNING) would need SELECT: that is why the writer uses createMany', async () => {
    await expect(
      api.auditLog.create({
        data: { id: randomUUID(), action: 'x', resourceType: 'y', result: 'success' },
      }),
    ).rejects.toThrow(denied);
  });

  it.each([
    ['reading', 'SELECT count(*) FROM security.audit_log'],
    ['updating', "UPDATE security.audit_log SET action = 'tampered'"],
    ['deleting', 'DELETE FROM security.audit_log'],
    ['truncating', 'TRUNCATE security.audit_log'],
  ])('the application role is denied %s', async (_what, statement) => {
    await insertAuditRowAsApi();
    await expect(run(api, statement)).rejects.toThrow(denied);
  });

  it('the application role cannot alter, disable or drop the triggers or the table (that needs ownership)', async () => {
    for (const statement of [
      'ALTER TABLE security.audit_log DISABLE TRIGGER audit_log_no_update_delete',
      'ALTER TABLE security.audit_log DISABLE TRIGGER audit_log_no_truncate',
      'ALTER TABLE security.audit_log DISABLE TRIGGER ALL',
      'DROP TRIGGER audit_log_no_update_delete ON security.audit_log',
      'DROP TABLE security.audit_log',
      'ALTER TABLE security.audit_log OWNER TO agentos_api',
      'DROP FUNCTION security.audit_log_reject_changes() CASCADE',
    ])
      await expect(run(api, statement), statement).rejects.toThrow(/must be owner|permission denied/i);
    // A GRANT by a role that is not the owner is not an error in PostgreSQL (it only warns); what matters is that it changes nothing.
    await run(api, 'GRANT UPDATE, DELETE, SELECT ON security.audit_log TO agentos_api').catch(
      () => undefined,
    );
    const gained = await query<{ update: boolean; delete: boolean; select: boolean }>(
      owner,
      `SELECT has_table_privilege('agentos_api', 'security.audit_log', 'UPDATE') AS "update",
              has_table_privilege('agentos_api', 'security.audit_log', 'DELETE') AS "delete",
              has_table_privilege('agentos_api', 'security.audit_log', 'SELECT') AS "select"`,
    );
    expect(gained).toEqual([{ update: false, delete: false, select: false }]);
    // Still in force afterwards.
    const triggers = await query<{ name: string; enabled: string }>(
      owner,
      `SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger WHERE tgrelid = 'security.audit_log'::regclass AND NOT tgisinternal ORDER BY 1`,
    );
    expect(triggers).toEqual([
      { name: 'audit_log_no_truncate', enabled: 'O' },
      { name: 'audit_log_no_update_delete', enabled: 'O' },
    ]);
  });

  it('the triggers stop UPDATE, DELETE and TRUNCATE even for the table OWNER (defense in depth behind the privileges)', async () => {
    await insertAuditRowAsApi();
    await expect(run(owner, "UPDATE security.audit_log SET action = 'tampered'")).rejects.toThrow(appendOnly);
    await expect(run(owner, 'DELETE FROM security.audit_log')).rejects.toThrow(appendOnly);
    // The statement-level trigger: TRUNCATE is not a row operation, so the row trigger alone would not catch it.
    await expect(run(owner, 'TRUNCATE security.audit_log')).rejects.toThrow(appendOnly);
    const remaining = await query<{ n: bigint }>(owner, 'SELECT count(*) AS n FROM security.audit_log');
    expect(Number(remaining[0]?.n)).toBeGreaterThan(0);
  });

  it('BOUNDARY, recorded on purpose: the table OWNER can disable the triggers, so ownership is outside the protection', async () => {
    // This is not a flaw to fix in this phase; it is what the ADR states. A superuser or a schema owner can bypass the guard,
    // which is why the application must never connect as one. Restored immediately.
    await insertAuditRowAsApi();
    await run(owner, 'ALTER TABLE security.audit_log DISABLE TRIGGER audit_log_no_update_delete');
    try {
      await expect(
        run(owner, "UPDATE security.audit_log SET action = 'edited-by-owner'"),
      ).resolves.toBeGreaterThan(0);
    } finally {
      await run(owner, 'ALTER TABLE security.audit_log ENABLE TRIGGER audit_log_no_update_delete');
    }
    await expect(run(owner, "UPDATE security.audit_log SET action = 'again'")).rejects.toThrow(appendOnly);
  });
});

/*
 * The canonical email is a property of the DATA, not only of the application (migration `identity_email_canonical_check`):
 *   CHECK (email ~ '^[!-~]+$' AND email = lower(email COLLATE "C"))
 * i.e. printable ASCII only (no space, no tab or other control character, nothing non-ASCII) and no upper case. These tests talk to
 * PostgreSQL directly, with the real API role, and prove the constraint matches the application's `canonicalizeEmail` contract.
 */

const CODE = (...points: number[]) => points.map((point) => String.fromCodePoint(point)).join('');

/** The SQLSTATE of a failed raw query, as Prisma reports it. */
function sqlstateOf(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: string } } | undefined)?.meta;
  return meta?.code ?? (error as { code?: string } | undefined)?.code;
}

/** Inserts a user with exactly this email text (parameterized: the text is data, never SQL). */
const insertUser = (client: PrismaClient, email: string) =>
  client.$executeRaw`INSERT INTO identity."user" (id, email, display_name, updated_at) VALUES (${randomUUID()}::uuid, ${email}, 'Email Test', now())`;

const attempt = async (client: PrismaClient, email: string) => {
  try {
    await insertUser(client, email);
    return 'accepted' as const;
  } catch (error) {
    return sqlstateOf(error) ?? 'unknown error';
  }
};

describe('the email is canonical in the database itself', () => {
  const CHECK_VIOLATION = '23514';

  // Each of these is NOT in canonical form, so the database must refuse it whatever wrote it (the API role included).
  it.each([
    ['upper case', 'Alice@Example.com'],
    ['upper case in the domain only', 'alice@Example.com'],
    ['a leading space', ' alice@example.com'],
    ['a trailing space', 'alice@example.com '],
    ['a leading tab', CODE(0x9) + 'alice@example.com'],
    ['a trailing tab', 'alice@example.com' + CODE(0x9)],
    ['a trailing line feed', 'alice@example.com' + CODE(0xa)],
    ['a trailing carriage return', 'alice@example.com' + CODE(0xd)],
    ['a vertical tab', CODE(0xb) + 'alice@example.com'],
    ['a form feed', 'alice@example.com' + CODE(0xc)],
    ['a no-break space (U+00A0)', CODE(0xa0) + 'alice@example.com'],
    ['an em space (U+2003)', 'alice@example.com' + CODE(0x2003)],
    ['an ideographic space (U+3000)', CODE(0x3000) + 'alice@example.com'],
    ['a byte order mark (U+FEFF)', CODE(0xfeff) + 'alice@example.com'],
    ['a line separator (U+2028)', 'alice@example.com' + CODE(0x2028)],
    ['an inner space', 'ali ce@example.com'],
    ['a control character (U+0001)', 'ali' + CODE(0x1) + 'ce@example.com'],
    ['a DEL character (U+007F)', 'ali' + CODE(0x7f) + 'ce@example.com'],
    ['a non-ASCII letter in lower case', CODE(0xe4) + '@example.com'],
    ['a non-ASCII domain', 'alice@ex' + CODE(0xe4) + 'mple.com'],
    ['a fullwidth letter', CODE(0xff41) + '@example.com'],
    ['the Turkish dotted capital I', CODE(0x130) + 'stanbul@example.com'],
    ['the empty string', ''],
  ])('refuses %s with SQLSTATE 23514', async (_label, email) => {
    expect(await attempt(api, email)).toBe(CHECK_VIOLATION);
    expect(await attempt(owner, email)).toBe(CHECK_VIOLATION); // the table owner is bound by it too
  });

  it('accepts the canonical form, including every character the application allows in a local part or a domain', async () => {
    for (const email of [
      `plain-${randomUUID()}@example.com`,
      `dots.and+plus_and-dash.${randomUUID()}@sub-domain.example.org`,
      `o'brien-${randomUUID()}@example.com`, // the apostrophe is valid and is printable ASCII
      `digits0123456789-${randomUUID()}@x1.co`,
    ])
      expect(await attempt(api, email), email).toBe('accepted');
  });

  it('matches the application contract: whatever canonicalizeEmail + emailSchema produce is accepted, its raw input is refused unless already canonical', async () => {
    const spellings = [
      '  Contract.One@Example.COM  ',
      CODE(0x9) + 'contract.two@example.com' + CODE(0xa),
      CODE(0xa0) + 'Contract.Three@Example.com' + CODE(0x3000),
      CODE(0xfeff) + "O'Brien.Four@Example.Org" + CODE(0x2003),
      'contract.five@example.com', // already canonical
    ];
    for (const raw of spellings) {
      const canonical = emailSchema.parse(raw);
      expect(canonical).toBe(canonicalizeEmail(raw));
      const unique = canonical.replace('@', `.${randomUUID().slice(0, 8)}@`);
      expect(await attempt(api, unique), `canonical form of ${JSON.stringify(raw)}`).toBe('accepted');
      const rawUnique = raw.replace(/(@)/, `.${randomUUID().slice(0, 8)}$1`);
      const alreadyCanonical = canonicalizeEmail(rawUnique) === rawUnique;
      expect(await attempt(api, rawUnique), `raw ${JSON.stringify(rawUnique)}`).toBe(
        alreadyCanonical ? 'accepted' : CHECK_VIOLATION,
      );
    }
  });

  it('also guards UPDATE, and refuses a case variant with the check violation before it could ever collide on the unique index', async () => {
    const email = `update-${randomUUID()}@example.com`;
    expect(await attempt(api, email)).toBe('accepted');
    const update = api.$executeRaw`UPDATE identity."user" SET email = ${email.toUpperCase()} WHERE email = ${email}`;
    await expect(update).rejects.toMatchObject({ meta: { code: CHECK_VIOLATION } });
    expect(await attempt(api, email.toUpperCase())).toBe(CHECK_VIOLATION); // not 23505: the variant never gets that far
    expect(await attempt(api, email)).toBe('23505'); // the exact duplicate IS a unique violation
  });
});

describe('the email migration never rewrites existing data', () => {
  const sqlFile = readFileSync(
    resolve(__dirname, '../prisma/migrations/20261115130000_identity_email_canonical_check/migration.sql'),
    'utf8',
  );
  const [guardSql, addConstraintSql] = sqlFile.split('-- == add the constraint ==') as [string, string];
  // The guard is the `DO $$ ... $$;` statement; the comments before it are not part of the statement.
  const guard = guardSql.slice(guardSql.indexOf('DO $$')).trim().replace(/;$/, '');
  const addConstraint = addConstraintSql.trim().replace(/;$/, '');

  it('stops with an actionable message, changes nothing, and succeeds once the rows were corrected by a person', async () => {
    const database = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
    await database.applyMigrations();
    const mine = new PrismaClient({ datasourceUrl: database.urlFor('migrate') });
    try {
      // The state a database could be in BEFORE this migration: no constraint, a few rows that violate the invariant.
      await run(mine, 'ALTER TABLE identity."user" DROP CONSTRAINT user_email_canonical');
      const keep = [
        `Legacy-${uid()}@Example.com`,
        ` padded-${uid()}@example.com`,
        `fine-${uid()}@example.com`,
      ];
      for (const email of keep) await insertUser(mine, email);
      const before = await query<{ email: string }>(mine, 'SELECT email FROM identity."user" ORDER BY email');

      const failure = (await run(mine, guard).catch((error: unknown) => error)) as Error;
      expect(failure).toBeInstanceOf(Error);
      const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure)) + String(failure);
      expect(text).toMatch(/identity\.user_email_canonical cannot be added/);
      expect(text).toMatch(/2 user row\(s\)/); // the two violating rows, counted
      expect(text).toMatch(/Nothing was changed/);
      expect(text).toMatch(/migrate resolve --rolled-back 20261115130000_identity_email_canonical_check/);
      expect(sqlstateOf(failure)).toBe('23514');
      // No email text leaks into the migration error (it would end up in deployment logs).
      expect(text).not.toContain('Legacy-');
      expect(text).not.toContain('padded-');

      // Nothing was rewritten, and the constraint was not added.
      expect(await query(mine, 'SELECT email FROM identity."user" ORDER BY email')).toEqual(before);
      const constraint = await query(
        mine,
        `SELECT 1 FROM pg_constraint WHERE conname = 'user_email_canonical'`,
      );
      expect(constraint).toHaveLength(0);

      // A person decides what happens to those accounts; here they are removed. Then the same migration goes through.
      await run(mine, `DELETE FROM identity."user" WHERE email <> lower(email) OR email <> btrim(email)`);
      await expect(run(mine, guard)).resolves.not.toThrow();
      await run(mine, addConstraint);
      expect(await attempt(mine, `Again-${uid()}@Example.com`)).toBe('23514');
      expect(await query<{ email: string }>(mine, 'SELECT email FROM identity."user"')).toEqual([
        { email: keep[2] },
      ]);
    } finally {
      await mine.$disconnect();
      await database.drop();
    }
  });
});
