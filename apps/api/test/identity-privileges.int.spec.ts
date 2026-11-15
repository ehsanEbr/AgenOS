import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
