import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack';

/*
 * Projects through the complete stack as a black box (ADR-0011): the web container proxies /api to the API container, which connects to
 * PostgreSQL as its own non-superuser role against tables the MIGRATION role created, including the new `projects` schema and its
 * column-level grants. This is the part only the Compose stack can show: the migration role creating a schema, and the API role
 * working with exactly the privileges the migrations granted. One throwaway project (own volumes, network, ports and credentials).
 * The tests run in order and share the stack. The browser-level scenario belongs to Phase 2.4.
 */

let stack: Stack;
const PASSWORD = 'a long system test password';

beforeAll(async () => {
  stack = await Stack.create({ env: { AUTH_ALLOW_REGISTRATION: 'true' } }); // several people have to register
  await stack.up(['api', 'web']);
});
afterAll(async () => {
  await stack.destroy();
});

const api = (path: string, token?: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(stack.webUrl(`/api/v1${path}`), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

interface Person {
  id: string;
  email: string;
  token: string;
}
async function signUp(name: string): Promise<Person> {
  const email = `${name}@example.com`;
  const registered = await api('/auth/register', undefined, {
    body: { email, displayName: name, password: PASSWORD },
  });
  expect(registered.status).toBe(201);
  const { user } = (await registered.json()) as { user: { id: string } };
  const login = await api('/auth/login', undefined, {
    body: { email, password: PASSWORD, delivery: 'token' },
  });
  expect(login.status).toBe(200);
  const { token } = (await login.json()) as { token: string };
  return { id: user.id, email, token };
}

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
const asMigrate = async (sql: string) =>
  (await sqlAs('agentos_migrate', stack.migratePassword, sql)).stdout.trim();

describe('the projects schema, created by the migration role', () => {
  it('has its tables owned by agentos_migrate, and the API role holds exactly the granted privileges, column by column', async () => {
    expect(
      await asMigrate(
        "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname = 'projects'",
      ),
    ).toBe('agentos_migrate');
    expect(await asMigrate("SELECT count(*) FROM pg_tables WHERE schemaname = 'projects'")).toBe('2');

    const privileges = await asMigrate(
      `SELECT concat_ws(',',
         has_table_privilege('agentos_api', 'projects.project', 'INSERT'),
         has_table_privilege('agentos_api', 'projects.project', 'SELECT'),
         has_table_privilege('agentos_api', 'projects.project', 'DELETE'),
         has_table_privilege('agentos_api', 'projects.project_member', 'DELETE'),
         has_column_privilege('agentos_api', 'projects.project', 'name', 'UPDATE'),
         has_column_privilege('agentos_api', 'projects.project', 'status', 'UPDATE'),
         has_column_privilege('agentos_api', 'projects.project', 'organization_id', 'UPDATE'),
         has_column_privilege('agentos_api', 'projects.project', 'slug', 'UPDATE'),
         has_column_privilege('agentos_api', 'projects.project_member', 'role', 'UPDATE'),
         has_column_privilege('agentos_api', 'projects.project_member', 'user_id', 'UPDATE'))`,
    );
    // INSERT, SELECT yes; DELETE on project no; DELETE on project_member yes; name and status updatable; organization_id and slug NOT;
    // role updatable; user_id NOT. (psql prints booleans as t and f.)
    expect(privileges).toBe('t,t,f,t,t,t,f,f,t,f');
  });

  it('applied every migration (the two project migrations included) and left the audit trail append-only', async () => {
    expect(
      Number(await asMigrate('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL')),
    ).toBeGreaterThanOrEqual(7);
    expect(await asMigrate("SELECT has_table_privilege('agentos_api', 'security.audit_log', 'UPDATE')")).toBe(
      'f',
    );
  });
});

describe('organization -> project -> project member, end to end', () => {
  let ada: Person; // owner of the organization
  let bob: Person; // organization member, creates the project
  let cara: Person; // organization viewer
  let eve: Person; // owner of ANOTHER organization
  let organization: string;
  let project: string;

  it('registers people, creates an organization and adds members by email', async () => {
    [ada, bob, cara, eve] = [
      await signUp('ada'),
      await signUp('bob'),
      await signUp('cara'),
      await signUp('eve'),
    ];
    const created = await api('/organizations', ada.token, { body: { name: 'Analytical Engines' } });
    expect(created.status).toBe(201);
    organization = ((await created.json()) as { id: string }).id;
    expect((await api('/organizations', eve.token, { body: { name: 'Elsewhere' } })).status).toBe(201);
    for (const [person, role] of [
      [bob, 'member'],
      [cara, 'viewer'],
    ] as const)
      expect(
        (
          await api(`/organizations/${organization}/members`, ada.token, {
            body: { email: person.email, role },
          })
        ).status,
      ).toBe(201);
  });

  it('lets a member create a project and become its project_admin; the organization owner sees it with no membership of their own', async () => {
    const response = await api('/projects', bob.token, {
      body: { organizationId: organization, name: 'Difference Engine', slug: 'difference-engine' },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; projectRole: string; slug: string };
    project = body.id;
    expect(body).toMatchObject({ projectRole: 'project_admin', slug: 'difference-engine' });

    const asOwner = (await (await api(`/projects?organizationId=${organization}`, ada.token)).json()) as {
      items: { id: string; projectRole: string | null }[];
      page: { total: number };
    };
    expect(asOwner.items).toEqual([expect.objectContaining({ id: project, projectRole: null })]); // implicit access
    expect(
      await asMigrate(`SELECT count(*) FROM projects.project_member WHERE project_id = '${project}'`),
    ).toBe('1');
  });

  it('shows an organization viewer nothing until they are added to the project, then only that', async () => {
    const before = (await (await api(`/projects?organizationId=${organization}`, cara.token)).json()) as {
      items: unknown[];
      page: { total: number };
    };
    expect([before.items.length, before.page.total]).toEqual([0, 0]);
    expect((await api(`/projects/${project}`, cara.token)).status).toBe(404); // the same answer as for a project that does not exist

    expect(
      (
        await api(`/projects/${project}/members`, bob.token, {
          body: { userId: cara.id, projectRole: 'project_viewer' },
        })
      ).status,
    ).toBe(201);
    expect((await api(`/projects/${project}`, cara.token)).status).toBe(200);
    expect(
      (await api(`/projects/${project}`, cara.token, { method: 'PATCH', body: { name: 'Mine now' } })).status,
    ).toBe(403); // can see, cannot change
  });

  it('keeps another organization out: the same 404 for the project and for the organization selector', async () => {
    const missing = await api(`/projects/00000000-0000-0000-0000-000000000000`, eve.token);
    for (const path of [`/projects/${project}`, `/projects/${project}/members`]) {
      const response = await api(path, eve.token);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'project_not_found' });
    }
    expect(missing.status).toBe(404);
    const foreignList = await api(`/projects?organizationId=${organization}`, eve.token);
    expect(foreignList.status).toBe(404);
    expect(await foreignList.json()).toMatchObject({ code: 'organization_not_found' });
    expect((await api(`/projects/${project}`)).status).toBe(401);
  });

  it('archives and restores idempotently, and an archived project accepts no change', async () => {
    const first = await api(`/projects/${project}/archive`, ada.token, { method: 'POST', body: undefined });
    expect(first.status).toBe(200);
    const again = await api(`/projects/${project}/archive`, ada.token, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(
      await asMigrate(
        `SELECT count(*) FROM security.audit_log WHERE project_id = '${project}' AND action = 'project.archived'`,
      ),
    ).toBe('1');
    expect(
      (await api(`/projects/${project}`, bob.token, { method: 'PATCH', body: { name: 'No' } })).status,
    ).toBe(409);
    expect((await api(`/projects/${project}/restore`, ada.token, { method: 'POST' })).status).toBe(200);
    expect(
      (
        await api(`/projects/${project}`, bob.token, {
          method: 'PATCH',
          body: { name: 'Difference Engine No. 2' },
        })
      ).status,
    ).toBe(200);
  });

  it('applies an organization role change to the very next request', async () => {
    expect((await api(`/projects/${project}`, ada.token)).status).toBe(200);
    expect(
      (
        await api(`/organizations/${organization}/members/${bob.id}`, ada.token, {
          method: 'PATCH',
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(200);
    // bob lost nothing he had explicitly: his own project_admin row still stands; but organization-level rights are those of a viewer
    expect(
      (await api(`/projects/${project}`, bob.token, { method: 'PATCH', body: { name: 'Still mine' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await api('/projects', bob.token, {
          body: { organizationId: organization, name: 'Second', slug: 'second' },
        })
      ).status,
    ).toBe(403);
  });

  it('removes a user from the organization together with their project memberships, in one step', async () => {
    expect(await asMigrate(`SELECT count(*) FROM projects.project_member WHERE user_id = '${cara.id}'`)).toBe(
      '1',
    );
    expect(
      (await api(`/organizations/${organization}/members/${cara.id}`, ada.token, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(await asMigrate(`SELECT count(*) FROM projects.project_member WHERE user_id = '${cara.id}'`)).toBe(
      '0',
    );
    expect((await api(`/projects/${project}`, cara.token)).status).toBe(404);
    expect(
      await asMigrate(
        `SELECT metadata->>'reason' FROM security.audit_log WHERE project_id = '${project}' AND action = 'project_member.removed' AND metadata->>'userId' = '${cara.id}'`,
      ),
    ).toBe('organization_membership_removed');
    // the foreign keys leave nothing behind: no project membership without its organization membership
    expect(
      await asMigrate(
        `SELECT count(*) FROM projects.project_member pm WHERE NOT EXISTS (SELECT 1 FROM identity.membership m WHERE m.organization_id = pm.organization_id AND m.user_id = pm.user_id)`,
      ),
    ).toBe('0');
  });
});
