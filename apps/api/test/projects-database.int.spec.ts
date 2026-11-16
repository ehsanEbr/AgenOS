import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IsolatedDatabase, adminDatabaseUrl, createIsolatedDatabase } from './support/isolated-database';

/*
 * The project tables against REAL PostgreSQL, connecting as the roles the stack really uses (ADR-0011, decisions 7 and 9):
 *   agentos_migrate  owns the tables (not a superuser)
 *   agentos_api      what the API connects as: gets only what the migrations granted, column by column
 * Covers constraints, the two composite foreign keys, the column-level grants, and the lock protocol on the real tables.
 * Requires `pnpm infra:up`.
 */

let db: IsolatedDatabase;
let api: PrismaClient;
let owner: PrismaClient;

const uid = () => randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
function sqlstateOf(error: unknown): string {
  const meta = (error as { meta?: { code?: string } } | undefined)?.meta;
  return meta?.code ?? (error as { code?: string } | undefined)?.code ?? 'unknown';
}
/** The SQLSTATE a statement fails with, or 'accepted'. */
const outcome = async (work: PromiseLike<unknown>) => {
  try {
    await work;
    return 'accepted';
  } catch (error) {
    return sqlstateOf(error);
  }
};
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const INVALID_TEXT = '22P02';
const LOCK_NOT_AVAILABLE = '55P03';
const INSUFFICIENT_PRIVILEGE = '42501';

const newUser = async () => {
  const id = randomUUID();
  await owner.$executeRaw`INSERT INTO identity."user" (id, email, display_name, updated_at) VALUES (${id}::uuid, ${`p-${uid()}@example.com`}, 'Project Test', now())`;
  return id;
};
const newOrganization = async () => {
  const id = randomUUID();
  await api.$executeRaw`INSERT INTO identity.organization (id, name, updated_at) VALUES (${id}::uuid, 'Org', now())`;
  return id;
};
const join = (client: PrismaClient, organizationId: string, userId: string, role = 'member') =>
  client.$executeRawUnsafe(
    `INSERT INTO identity.membership (id, organization_id, user_id, role, updated_at) VALUES ('${randomUUID()}', '${organizationId}', '${userId}', '${role}', now())`,
  );
const insertProject = (
  client: PrismaClient,
  organizationId: string,
  slug: string,
  id = randomUUID(),
  name = 'Project',
) =>
  client.$executeRaw`INSERT INTO projects.project (id, organization_id, name, slug, updated_at) VALUES (${id}::uuid, ${organizationId}::uuid, ${name}, ${slug}, now())`;
const insertMember = (
  client: PrismaClient,
  projectId: string,
  organizationId: string,
  userId: string,
  role = 'project_member',
) =>
  client.$executeRawUnsafe(
    `INSERT INTO projects.project_member (id, project_id, organization_id, user_id, role, updated_at) VALUES ('${randomUUID()}', '${projectId}', '${organizationId}', '${userId}', '${role}', now())`,
  );
const count = async (sql: string) => Number((await owner.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]?.n);

/** A world: one organization with `n` users who are members, and one project. */
async function world(users = 3) {
  const organization = await newOrganization();
  const members: string[] = [];
  for (let i = 0; i < users; i += 1) {
    const user = await newUser();
    await join(api, organization, user);
    members.push(user);
  }
  const project = randomUUID();
  await insertProject(api, organization, `p-${uid()}`, project);
  return { organization, members, project };
}

beforeAll(async () => {
  db = await createIsolatedDatabase(adminDatabaseUrl(), { owner: 'agentos_migrate' });
  await db.applyMigrations();
  const withPool = (url: string) => `${url}${url.includes('?') ? '&' : '?'}connection_limit=40`;
  api = new PrismaClient({ datasourceUrl: withPool(db.urlFor('api')) });
  owner = new PrismaClient({ datasourceUrl: db.urlFor('migrate') });
}, 120_000);

afterAll(async () => {
  await Promise.all([api?.$disconnect(), owner?.$disconnect()]);
  await db?.drop();
});

describe('the project tables belong to the migration role', () => {
  it('are owned by agentos_migrate (not a superuser), in their own schema, and the API role owns nothing', async () => {
    const rows = await owner.$queryRaw<{ owner: string; table: string }[]>`
      SELECT tableowner AS owner, tablename AS "table" FROM pg_tables WHERE schemaname = 'projects' ORDER BY 2`;
    expect(rows).toEqual([
      { owner: 'agentos_migrate', table: 'project' },
      { owner: 'agentos_migrate', table: 'project_member' },
    ]);
    const schema = await owner.$queryRaw<{ owner: string }[]>`
      SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'projects'`;
    expect(schema).toEqual([{ owner: 'agentos_migrate' }]);
    await expect(api.$executeRawUnsafe('CREATE TABLE projects.nope (i int)')).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('project constraints', () => {
  it('refuses a slug that is not lower-case letters, digits and single hyphens of 2 to 48 characters', async () => {
    const organization = await newOrganization();
    for (const bad of [
      'a',
      'x'.repeat(49),
      'Mixed-Case',
      'under_score',
      '-lead',
      'trail-',
      'dou--ble',
      'with space',
      'ünï',
      '',
      'a/b',
    ])
      expect(await outcome(insertProject(api, organization, bad)), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    for (const good of ['ab', 'a-b', 'a1-b2', 'x'.repeat(48)])
      expect(await outcome(insertProject(api, organization, good)), good).toBe('accepted');
  });

  it('refuses an empty, blank or oversized name and description', async () => {
    const organization = await newOrganization();
    for (const name of ['', '    ', 'x'.repeat(101)])
      expect(
        await outcome(insertProject(api, organization, `n-${uid()}`, randomUUID(), name)),
        JSON.stringify(name),
      ).toBe(CHECK_VIOLATION);
    const insertWith = (description: string | null) =>
      api.$executeRaw`INSERT INTO projects.project (id, organization_id, name, slug, description, updated_at) VALUES (${randomUUID()}::uuid, ${organization}::uuid, 'P', ${`d-${uid()}`}, ${description}, now())`;
    for (const bad of ['', '   ', 'x'.repeat(2001)])
      expect(await outcome(insertWith(bad)), JSON.stringify(bad.slice(0, 5))).toBe(CHECK_VIOLATION);
    for (const good of [null, 'x', 'x'.repeat(2000)])
      expect(await outcome(insertWith(good))).toBe('accepted');
  });

  it('keeps status and archived_at in agreement, on insert and on update', async () => {
    const { organization, project } = await world(1);
    expect(
      await outcome(
        api.$executeRaw`INSERT INTO projects.project (id, organization_id, name, slug, status, updated_at) VALUES (${randomUUID()}::uuid, ${organization}::uuid, 'P', ${`s-${uid()}`}, 'archived', now())`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        api.$executeRaw`UPDATE projects.project SET status = 'archived' WHERE id = ${project}::uuid`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        api.$executeRaw`UPDATE projects.project SET archived_at = now() WHERE id = ${project}::uuid`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await outcome(
        api.$executeRaw`UPDATE projects.project SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = ${project}::uuid`,
      ),
    ).toBe('accepted');
    expect(
      await outcome(
        api.$executeRaw`UPDATE projects.project SET status = 'active', archived_at = NULL, updated_at = now() WHERE id = ${project}::uuid`,
      ),
    ).toBe('accepted');
  });

  it('makes the slug unique per organization only, archived projects included', async () => {
    const [a, b] = [await newOrganization(), await newOrganization()];
    const first = randomUUID();
    await insertProject(api, a, 'shared-slug', first);
    expect(await outcome(insertProject(api, a, 'shared-slug'))).toBe(UNIQUE_VIOLATION);
    expect(await outcome(insertProject(api, b, 'shared-slug'))).toBe('accepted'); // another organization: no collision
    await api.$executeRaw`UPDATE projects.project SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = ${first}::uuid`;
    expect(await outcome(insertProject(api, a, 'shared-slug'))).toBe(UNIQUE_VIOLATION); // an archived project keeps its slug
  });

  it('refuses a project of an organization that does not exist', async () => {
    expect(await outcome(insertProject(api, randomUUID(), 'ghost'))).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('project membership integrity (the composite foreign keys)', () => {
  it('accepts a member of the project organization, once', async () => {
    const { organization, members, project } = await world();
    expect(await outcome(insertMember(api, project, organization, members[0]!))).toBe('accepted');
    expect(await outcome(insertMember(api, project, organization, members[0]!, 'project_admin'))).toBe(
      UNIQUE_VIOLATION,
    );
    expect(await outcome(insertMember(api, project, organization, members[1]!, 'sovereign'))).toBe(
      INVALID_TEXT,
    );
  });

  it('refuses a user who is not a member of the project organization (even a member of another organization)', async () => {
    const one = await world();
    const two = await world();
    const stranger = await newUser();
    expect(await outcome(insertMember(api, one.project, one.organization, stranger))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(await outcome(insertMember(api, one.project, one.organization, two.members[0]!))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('refuses a membership whose organization differs from the project organization, whichever side lies', async () => {
    const one = await world();
    const two = await world();
    // a member of ORGANIZATION TWO, attached to a project of ORGANIZATION ONE, claiming either organization:
    expect(await outcome(insertMember(api, one.project, two.organization, two.members[0]!))).toBe(
      FOREIGN_KEY_VIOLATION,
    ); // project is not in two
    expect(await outcome(insertMember(api, one.project, one.organization, two.members[0]!))).toBe(
      FOREIGN_KEY_VIOLATION,
    ); // user is not in one
    expect(await outcome(insertMember(api, randomUUID(), one.organization, one.members[0]!))).toBe(
      FOREIGN_KEY_VIOLATION,
    ); // no such project
    expect(
      await count(`SELECT count(*) AS n FROM projects.project_member WHERE project_id = '${one.project}'`),
    ).toBe(0);
  });

  it('never cascades: the organization membership, the project and the organization cannot be deleted under their dependents', async () => {
    const { organization, members, project } = await world();
    await insertMember(api, project, organization, members[0]!);
    // even the OWNER of the tables is stopped by the foreign keys, so a missing cleanup fails loudly instead of leaving an orphan
    expect(
      await outcome(
        owner.$executeRawUnsafe(
          `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${members[0]}'`,
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await outcome(owner.$executeRawUnsafe(`DELETE FROM projects.project WHERE id = '${project}'`)),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await outcome(
        owner.$executeRawUnsafe(`DELETE FROM identity.organization WHERE id = '${organization}'`),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    // once the dependents are gone the same deletes work (the cleanup order of the removal participant)
    await api.$executeRawUnsafe(`DELETE FROM projects.project_member WHERE project_id = '${project}'`);
    expect(
      await outcome(
        api.$executeRawUnsafe(
          `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${members[0]}'`,
        ),
      ),
    ).toBe('accepted');
  });
});

describe('what the application role may do, column by column', () => {
  const columns = async (table: string) =>
    (
      await owner.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'projects' AND table_name = '${table}' ORDER BY ordinal_position`,
      )
    ).map((row) => row.column_name);
  const updatable = async (table: string) => {
    const result: string[] = [];
    for (const column of await columns(table)) {
      const [row] = await owner.$queryRawUnsafe<{ ok: boolean }[]>(
        `SELECT has_column_privilege('agentos_api', 'projects.${table}', '${column}', 'UPDATE') AS ok`,
      );
      if (row?.ok) result.push(column);
    }
    return result;
  };

  it('may update exactly the mutable columns of a project, and nothing else', async () => {
    expect(await updatable('project')).toEqual([
      'name',
      'description',
      'status',
      'archived_at',
      'updated_at',
    ]);
  });

  it('may update only the role of a project membership', async () => {
    expect(await updatable('project_member')).toEqual(['role', 'updated_at']);
  });

  it('is refused (insufficient privilege) when it tries to move a project, rename its slug or re-point a membership', async () => {
    const one = await world();
    const two = await world();
    await insertMember(api, one.project, one.organization, one.members[0]!);
    const denied = (sql: string) => outcome(api.$executeRawUnsafe(sql));
    expect(
      await denied(
        `UPDATE projects.project SET organization_id = '${two.organization}' WHERE id = '${one.project}'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await denied(`UPDATE projects.project SET slug = 'renamed' WHERE id = '${one.project}'`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await denied(`UPDATE projects.project SET created_at = now() WHERE id = '${one.project}'`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await denied(
        `UPDATE projects.project_member SET user_id = '${one.members[1]}' WHERE project_id = '${one.project}'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await denied(
        `UPDATE projects.project_member SET project_id = '${two.project}' WHERE project_id = '${one.project}'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await denied(
        `UPDATE projects.project_member SET organization_id = '${two.organization}' WHERE project_id = '${one.project}'`,
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // and the allowed changes work
    expect(
      await denied(
        `UPDATE projects.project SET name = 'New', description = 'text', updated_at = now() WHERE id = '${one.project}'`,
      ),
    ).toBe('accepted');
    expect(
      await denied(
        `UPDATE projects.project_member SET role = 'project_admin', updated_at = now() WHERE project_id = '${one.project}'`,
      ),
    ).toBe('accepted');
    // the data did not move
    expect(
      await count(
        `SELECT count(*) AS n FROM projects.project WHERE id = '${one.project}' AND organization_id = '${one.organization}'`,
      ),
    ).toBe(1);
  });

  it('cannot delete projects or truncate either table, but can delete project memberships', async () => {
    const { organization, members, project } = await world();
    await insertMember(api, project, organization, members[0]!);
    for (const statement of [
      'DELETE FROM projects.project',
      'TRUNCATE projects.project CASCADE',
      'TRUNCATE projects.project_member',
    ])
      expect(await outcome(api.$executeRawUnsafe(statement)), statement).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await outcome(
        api.$executeRawUnsafe(`DELETE FROM projects.project_member WHERE project_id = '${project}'`),
      ),
    ).toBe('accepted');
  });

  it('may take the row locks the protocol needs: FOR UPDATE on a project, FOR SHARE and FOR UPDATE on a membership', async () => {
    const { organization, members, project } = await world();
    await api.$transaction(async (tx) => {
      expect(
        await tx.$queryRawUnsafe(
          `SELECT id FROM projects.project WHERE id = '${project}' AND organization_id = '${organization}' FOR UPDATE`,
        ),
      ).toHaveLength(1);
      expect(
        await tx.$queryRawUnsafe(
          `SELECT id FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${members[0]}' FOR SHARE`,
        ),
      ).toHaveLength(1);
    });
    await api.$transaction(async (tx) => {
      expect(
        await tx.$queryRawUnsafe(
          `SELECT id FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${members[0]}' FOR UPDATE`,
        ),
      ).toHaveLength(1);
    });
  });

  it('works through the generated Prisma client with these grants: create, rename, archive, restore, re-role', async () => {
    const { organization, members } = await world();
    const created = await api.project.create({
      data: { organizationId: organization, name: 'Via Prisma', slug: `prisma-${uid()}` },
    });
    expect(created.status).toBe('active');
    const renamed = await api.project.update({
      where: { id: created.id },
      data: { name: 'Renamed', description: 'now with text' },
    });
    expect(renamed).toMatchObject({ name: 'Renamed', description: 'now with text' });
    const archived = await api.project.update({
      where: { id: created.id },
      data: { status: 'archived', archivedAt: new Date() },
    });
    expect(archived.archivedAt).not.toBeNull();
    const restored = await api.project.update({
      where: { id: created.id },
      data: { status: 'active', archivedAt: null },
    });
    expect(restored.archivedAt).toBeNull();
    const member = await api.projectMember.create({
      data: {
        projectId: created.id,
        organizationId: organization,
        userId: members[0]!,
        role: 'project_viewer',
      },
    });
    expect(
      await api.projectMember.update({ where: { id: member.id }, data: { role: 'project_admin' } }),
    ).toMatchObject({ role: 'project_admin' });
    expect(await api.projectMember.deleteMany({ where: { id: member.id } })).toEqual({ count: 1 });
    // ...and a Prisma update of an immutable column is refused by the database, not just by the code
    await expect(
      api.project.update({ where: { id: created.id }, data: { slug: 'sneaky-rename' } }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('the lock protocol on the real tables (ADR-0011 decision 9)', () => {
  const HOLD = (organization: string, user: string) =>
    `SELECT id FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}' FOR SHARE`;
  const LOCK = (organization: string, user: string) =>
    `SELECT id FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}' FOR UPDATE`;
  const withLockTimeout = async (tx: Pick<PrismaClient, '$executeRawUnsafe'>) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
  };

  it('an add that holds the membership first makes the removal WAIT, then the removal sees and cleans the new row (no foreign-key error)', async () => {
    const { organization, members, project } = await world(2);
    const user = members[0]!;
    const held = gate();
    const release = gate();
    const add = api.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM projects.project WHERE id = '${project}' AND organization_id = '${organization}' FOR UPDATE`,
      ); // L2
      expect(await tx.$queryRawUnsafe(HOLD(organization, user))).toHaveLength(1); // L3, shared
      held.open();
      await release.promise;
      await insertMember(tx as unknown as PrismaClient, project, organization, user); // L4
    });
    await held.promise;

    // the removal cannot take the membership exclusively while the add is in flight...
    expect(
      await outcome(
        api.$transaction(async (tx) => {
          await withLockTimeout(tx);
          await tx.$queryRawUnsafe(LOCK(organization, user));
        }),
      ),
    ).toBe(LOCK_NOT_AVAILABLE);

    // ...and, once it can, its cleanup (a fresh statement) SEES the committed row
    const removal = api.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(LOCK(organization, user)); // L3, exclusive: waits for the add
      const removed = await tx.$queryRawUnsafe<{ id: string }[]>(
        `DELETE FROM projects.project_member WHERE organization_id = '${organization}' AND user_id = '${user}' RETURNING id`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}'`,
      );
      return removed.length;
    });
    await sleep(250);
    release.open();
    await add;
    expect(await removal).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM projects.project_member WHERE user_id = '${user}'`)).toBe(
      0,
    );
    expect(await count(`SELECT count(*) AS n FROM identity.membership WHERE user_id = '${user}'`)).toBe(0);
  });

  it('a removal that holds the membership first makes the add WAIT and then find no membership (nothing inserted)', async () => {
    const { organization, members } = await world(2);
    const user = members[0]!;
    const held = gate();
    const release = gate();
    const removal = api.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(LOCK(organization, user));
      await tx.$executeRawUnsafe(
        `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}'`,
      );
      held.open();
      await release.promise;
    });
    await held.promise;
    expect(
      await outcome(
        api.$transaction(async (tx) => {
          await withLockTimeout(tx);
          await tx.$queryRawUnsafe(HOLD(organization, user));
        }),
      ),
    ).toBe(LOCK_NOT_AVAILABLE);

    const add = api.$transaction(
      async (tx) => (await tx.$queryRawUnsafe<unknown[]>(HOLD(organization, user))).length,
    );
    await sleep(250);
    release.open();
    await removal;
    expect(await add).toBe(0); // "not a member": the caller answers 404 and inserts nothing
  });

  it('WITHOUT the hold the same race ends in the foreign-key backstop (RESTRICT), never in an orphan row', async () => {
    const { organization, members, project } = await world(2);
    const user = members[0]!;
    const held = gate();
    const release = gate();
    const add = api.$transaction(async (tx) => {
      await insertMember(tx as unknown as PrismaClient, project, organization, user); // no hold, no project lock
      held.open();
      await release.promise;
    });
    await held.promise;
    // the removal's cleanup cannot see the uncommitted row; its delete waits on the insert's foreign-key lock
    const removal = outcome(
      api.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM projects.project_member WHERE organization_id = '${organization}' AND user_id = '${user}'`,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}'`,
        );
      }),
    );
    await sleep(250);
    release.open();
    await add;
    expect(await removal).toBe(FOREIGN_KEY_VIOLATION);
    expect(await count(`SELECT count(*) AS n FROM identity.membership WHERE user_id = '${user}'`)).toBe(1); // nothing was lost
    expect(await count(`SELECT count(*) AS n FROM projects.project_member WHERE user_id = '${user}'`)).toBe(
      1,
    );
  });

  it('re-roling a member does not block a project-member insert, but a hold does conflict with it', async () => {
    const { organization, members, project } = await world(2);
    const user = members[0]!;
    const held = gate();
    const release = gate();
    const rerole = api.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE identity.membership SET role = 'admin', updated_at = now() WHERE organization_id = '${organization}' AND user_id = '${user}'`,
      );
      held.open();
      await release.promise;
    });
    await held.promise;
    // a non-key update takes FOR NO KEY UPDATE: the foreign-key check (FOR KEY SHARE) does not wait for it
    expect(
      await outcome(
        api.$transaction(async (tx) => {
          await withLockTimeout(tx);
          await insertMember(tx as unknown as PrismaClient, project, organization, user);
        }),
      ),
    ).toBe('accepted');
    // an explicit hold (FOR SHARE) does
    expect(
      await outcome(
        api.$transaction(async (tx) => {
          await withLockTimeout(tx);
          await tx.$queryRawUnsafe(HOLD(organization, user));
        }),
      ),
    ).toBe(LOCK_NOT_AVAILABLE);
    release.open();
    await rerole;
  });

  /**
   * The regression guard against the V0 deadlock (ADR-0011 evidence E7): the protocol as designed, run by many connections at once against
   * the real tables, mixing every kind of operation. The rule that keeps it deadlock-free is that project-side code holds at most ONE
   * organization-membership row; holding two (the actor and the target, as the first draft did) deadlocked with the owner lock.
   */
  describe('stress: mixed operations on many connections', () => {
    const WORKERS = 12;
    const ROUNDS = 250;

    it('produces no deadlock, no foreign-key failure on a supported path and no orphan row', async () => {
      const organization = await newOrganization();
      const users: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const user = await newUser();
        await join(api, organization, user, i < 2 ? 'owner' : 'member');
        users.push(user);
      }
      const projects: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const id = randomUUID();
        await insertProject(api, organization, `stress-${i}-${uid()}`, id);
        projects.push(id);
      }
      const ownersLock = (tx: PrismaClient) =>
        tx.$queryRawUnsafe(
          `SELECT id FROM identity.membership WHERE organization_id = '${organization}' AND role = 'owner' ORDER BY id FOR UPDATE`,
        );
      const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;
      const nonOwners = users.slice(2);

      const operations: Record<string, (tx: PrismaClient) => Promise<void>> = {
        async removeMember(tx) {
          // organization side: L1 -> L3 (exclusive) -> L4
          const user = pick(nonOwners);
          await ownersLock(tx);
          if ((await tx.$queryRawUnsafe<unknown[]>(LOCK(organization, user))).length === 0) return;
          await tx.$executeRawUnsafe(
            `DELETE FROM projects.project_member WHERE organization_id = '${organization}' AND user_id = '${user}'`,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM identity.membership WHERE organization_id = '${organization}' AND user_id = '${user}'`,
          );
        },
        async addMember(tx) {
          const user = pick(nonOwners);
          await ownersLock(tx);
          await tx.$executeRawUnsafe(
            `INSERT INTO identity.membership (id, organization_id, user_id, role, updated_at) VALUES ('${randomUUID()}', '${organization}', '${user}', 'member', now()) ON CONFLICT DO NOTHING`,
          );
        },
        async reroleMember(tx) {
          const user = pick(nonOwners);
          await ownersLock(tx);
          await tx.$executeRawUnsafe(
            `UPDATE identity.membership SET role = '${pick(['member', 'admin', 'viewer'])}', updated_at = now() WHERE organization_id = '${organization}' AND user_id = '${user}'`,
          );
        },
        async addProjectMember(tx) {
          // project side: L2 -> L3 (ONE shared row, the target) -> L4
          const project = pick(projects);
          await tx.$queryRawUnsafe(
            `SELECT id FROM projects.project WHERE id = '${project}' AND organization_id = '${organization}' FOR UPDATE`,
          );
          const target = pick(users);
          if ((await tx.$queryRawUnsafe<unknown[]>(HOLD(organization, target))).length === 0) return;
          await tx.$executeRawUnsafe(
            `INSERT INTO projects.project_member (id, project_id, organization_id, user_id, role, updated_at) VALUES ('${randomUUID()}', '${project}', '${organization}', '${target}', 'project_member', now()) ON CONFLICT DO NOTHING`,
          );
        },
        async changeProjectMember(tx) {
          const project = pick(projects);
          const user = pick(users);
          await tx.$queryRawUnsafe(
            `SELECT id FROM projects.project WHERE id = '${project}' AND organization_id = '${organization}' FOR UPDATE`,
          );
          if (Math.random() < 0.5)
            await tx.$executeRawUnsafe(
              `UPDATE projects.project_member SET role = 'project_admin', updated_at = now() WHERE project_id = '${project}' AND user_id = '${user}'`,
            );
          else
            await tx.$executeRawUnsafe(
              `DELETE FROM projects.project_member WHERE project_id = '${project}' AND user_id = '${user}'`,
            );
        },
        async archiveToggle(tx) {
          const project = pick(projects);
          await tx.$queryRawUnsafe(
            `SELECT id FROM projects.project WHERE id = '${project}' AND organization_id = '${organization}' FOR UPDATE`,
          );
          await tx.$executeRawUnsafe(
            Math.random() < 0.5
              ? `UPDATE projects.project SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = '${project}'`
              : `UPDATE projects.project SET status = 'active', archived_at = NULL, updated_at = now() WHERE id = '${project}'`,
          );
        },
        async createProject(tx) {
          // L3 (ONE shared row, the creator) -> insert project -> L4
          const creator = pick(users);
          if ((await tx.$queryRawUnsafe<unknown[]>(HOLD(organization, creator))).length === 0) return;
          const id = randomUUID();
          await insertProject(tx as unknown as PrismaClient, organization, `c-${uid()}-${uid()}`, id);
          await insertMember(tx as unknown as PrismaClient, id, organization, creator, 'project_admin');
        },
        async renameOrganization(tx) {
          await tx.$executeRawUnsafe(
            `UPDATE identity.organization SET name = 'Org ${uid()}', updated_at = now() WHERE id = '${organization}'`,
          );
        },
      };
      const names = Object.keys(operations);
      const failures: Record<string, number> = {};

      await Promise.all(
        Array.from({ length: WORKERS }, async () => {
          for (let i = 0; i < ROUNDS; i += 1) {
            const name = pick(names);
            try {
              await api.$transaction((tx) => operations[name]!(tx as unknown as PrismaClient), {
                timeout: 15_000,
                maxWait: 15_000,
              });
            } catch (error) {
              const key = `${name}: ${sqlstateOf(error)}`;
              failures[key] = (failures[key] ?? 0) + 1;
            }
          }
        }),
      );

      expect(failures).toEqual({}); // in particular no 40P01 (deadlock) and no 23503 (foreign key) on these supported paths
      const orphans = await count(
        `SELECT count(*) AS n FROM projects.project_member pm WHERE NOT EXISTS (SELECT 1 FROM identity.membership m WHERE m.organization_id = pm.organization_id AND m.user_id = pm.user_id)`,
      );
      expect(orphans).toBe(0);
    }, 120_000);
  });
});
