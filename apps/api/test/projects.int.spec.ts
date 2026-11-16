import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PROJECT_ROLES,
  type OrganizationRole,
  type ProjectRole,
  apiErrorSchema,
  paginatedSchema,
  projectSchema,
} from '@agentos/contracts';
import { type Harness, type Person, actionsOf, startHarness, uid } from './support/integration-harness';

/*
 * Projects end to end, in-process, against REAL PostgreSQL (a throwaway database with the real migrations, the application connecting as
 * the non-superuser API role) and REAL Redis (ADR-0011). Requires `pnpm infra:up`.
 *
 * The central guarantees tested here: only projects the caller can access are ever listed, counted or returned; everything else is the
 * same 404; the union of organization and project permissions applies to ONE project only; creating a project and its creator's
 * membership is atomic; every change commits together with its audit events; archive and restore are idempotent.
 */

let h: Harness;
const call = (person?: Person) => h.as(person?.token);
const errorOf = (body: unknown) => apiErrorSchema.parse(body);
const pageOfProjects = paginatedSchema(projectSchema);

beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

/** Rows the API cannot create yet (project memberships arrive with the member endpoints) are seeded as the migration role. */
async function seedProject(organizationId: string, slug = `s-${uid()}`, archived = false): Promise<string> {
  const id = randomUUID();
  await h.inspector.$executeRaw`
    INSERT INTO projects.project (id, organization_id, name, slug, status, archived_at, updated_at)
    VALUES (${id}::uuid, ${organizationId}::uuid, ${`Seeded ${slug}`}, ${slug}, ${archived ? 'archived' : 'active'}::projects.project_status,
            ${archived ? new Date() : null}, now())`;
  return id;
}
async function seedMember(projectId: string, organizationId: string, user: Person, role: ProjectRole) {
  await h.inspector.$executeRaw`
    INSERT INTO projects.project_member (id, project_id, organization_id, user_id, role, updated_at)
    VALUES (${randomUUID()}::uuid, ${projectId}::uuid, ${organizationId}::uuid, ${user.id}::uuid, ${role}::projects.project_role, now())`;
}
const projectRow = (id: string) => h.inspector.project.findUniqueOrThrow({ where: { id } });
const auditOf = (projectId: string) =>
  h.inspector.auditLog.findMany({ where: { projectId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
const createProject = async (who: Person, organizationId: string, slug = `p-${uid()}`, name = 'Apollo') => {
  const response = await call(who).post('/projects', { organizationId, name, slug });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectSchema.parse(response.body);
};

describe('creating a project', () => {
  let owner: Person;
  let member: Person;
  let viewer: Person;
  let organization: string;

  beforeAll(async () => {
    [owner, member, viewer] = [
      await h.signUp('co-owner'),
      await h.signUp('co-member'),
      await h.signUp('co-viewer'),
    ];
    organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, member, 'member');
    await h.addOrganizationMember(owner, organization, viewer, 'viewer');
  });

  it('makes the creator its project_admin in the SAME transaction, and records both events with the creator origin', async () => {
    const response = await call(member).post('/projects', {
      organizationId: organization,
      name: '  Apollo  ',
      slug: 'apollo',
      description: 'The first project',
    });
    expect(response.status).toBe(201);
    const project = projectSchema.parse(response.body);
    expect(project).toMatchObject({
      organizationId: organization,
      name: 'Apollo',
      slug: 'apollo',
      description: 'The first project',
      status: 'active',
      archivedAt: null,
      projectRole: 'project_admin',
    });

    const rows = await h.inspector.projectMember.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: member.id, organizationId: organization, role: 'project_admin' });

    const events = await auditOf(project.id);
    expect(actionsOf(events)).toEqual(['project.created', 'project_member.added']);
    expect(
      events.every((event) => event.actorUserId === member.id && event.organizationId === organization),
    ).toBe(true);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1); // one request
    expect(events.find((event) => event.action === 'project_member.added')?.metadata).toEqual({
      userId: member.id,
      role: 'project_admin',
      origin: 'project_created',
    });
    expect(events.find((event) => event.action === 'project_member.added')?.resourceId).toBe(rows[0]!.id);
    expect(JSON.stringify(events)).not.toContain('Apollo'); // no user-entered text in the trail
  });

  it('refuses a viewer (403), a stranger and a malformed organization (404), a missing selector (400), and creates nothing', async () => {
    const stranger = await h.signUp('co-stranger');
    const before = await h.inspector.project.count();
    expect(
      (await call(viewer).post('/projects', { organizationId: organization, name: 'X', slug: 'viewer-try' }))
        .status,
    ).toBe(403);
    for (const id of [organization, randomUUID(), 'not-a-uuid'])
      expect(
        (await call(stranger).post('/projects', { organizationId: id, name: 'X', slug: 'stranger-try' }))
          .status,
      ).toBe(404);
    expect((await call(member).post('/projects', { name: 'X', slug: 'no-selector' })).status).toBe(400);
    expect(await h.inspector.project.count()).toBe(before);
  });

  it('validates name and slug with 400 and creates nothing', async () => {
    const before = await h.inspector.project.count();
    for (const body of [
      { name: '', slug: 'valid-slug' },
      { name: 'X', slug: 'Not-Lower' },
      { name: 'X', slug: 'a' },
      { name: 'X', slug: 'with space' },
      { name: 'X'.repeat(101), slug: 'valid-slug' },
      { name: 'X', slug: 'valid-slug', description: '' },
    ])
      expect(
        (await call(member).post('/projects', { organizationId: organization, ...body })).status,
        JSON.stringify(body).slice(0, 60),
      ).toBe(400);
    expect(await h.inspector.project.count()).toBe(before);
  });

  it('answers 409 project_slug_taken for a duplicate slug in the organization, leaving no half-created rows', async () => {
    await createProject(member, organization, 'taken-slug');
    const projects = await h.inspector.project.count();
    const members = await h.inspector.projectMember.count();
    const events = await h.inspector.auditLog.count();
    const duplicate = await call(owner).post('/projects', {
      organizationId: organization,
      name: 'Again',
      slug: 'taken-slug',
    });
    expect([duplicate.status, errorOf(duplicate.body).code]).toEqual([409, 'project_slug_taken']);
    expect(await h.inspector.project.count()).toBe(projects);
    expect(await h.inspector.projectMember.count()).toBe(members);
    expect(await h.inspector.auditLog.count()).toBe(events);
  });

  it('lets the same slug exist in two organizations', async () => {
    const other = await h.signUp('co-other');
    const otherOrganization = await h.createOrganization(other);
    await createProject(other, otherOrganization, 'apollo'); // 'apollo' already exists in the first organization
  });

  it('keeps the creator effective after losing owner/admin status: the explicit membership stands until changed independently', async () => {
    const [boss, admin] = [await h.signUp('co-boss'), await h.signUp('co-admin')];
    const org = await h.createOrganization(boss);
    await h.addOrganizationMember(boss, org, admin, 'admin');
    const project = await createProject(admin, org, 'admins-project');
    expect((await call(admin).get(`/projects/${project.id}`)).status).toBe(200);

    await call(boss).patch(`/organizations/${org}/members/${admin.id}`, { role: 'viewer' }).expect(200);
    // as a plain viewer they have no implicit access any more, but their explicit project_admin row still gives it
    const after = await call(admin).get(`/projects/${project.id}`);
    expect(after.status).toBe(200);
    expect(projectSchema.parse(after.body).projectRole).toBe('project_admin');
    expect((await call(admin).patch(`/projects/${project.id}`, { name: 'Still mine' })).status).toBe(200);
    expect(
      (await call(admin).post('/projects', { organizationId: org, name: 'New', slug: 'viewer-cannot' }))
        .status,
    ).toBe(403);
  });
});

describe('creating the same slug at the same time', () => {
  it('has exactly one winner in an organization, leaves nothing from the losers, and never collides across organizations', async () => {
    const [a, b] = [await h.signUp('race-a'), await h.signUp('race-b')];
    const [orgA, orgB] = [await h.createOrganization(a), await h.createOrganization(b)];
    const slug = `race-${uid()}`;

    const same = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        call(a).post('/projects', { organizationId: orgA, name: `Racer ${index}`, slug }),
      ),
    );
    expect(same.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const winners = await h.inspector.project.findMany({ where: { organizationId: orgA, slug } });
    expect(winners).toHaveLength(1);
    expect(await h.inspector.projectMember.count({ where: { projectId: winners[0]!.id } })).toBe(1);
    expect(actionsOf(await auditOf(winners[0]!.id))).toEqual(['project.created', 'project_member.added']);

    // the same slug in two organizations, at the same time: both succeed
    const slug2 = `race-${uid()}`;
    const across = await Promise.all([
      call(a).post('/projects', { organizationId: orgA, name: 'A', slug: slug2 }),
      call(b).post('/projects', { organizationId: orgB, name: 'B', slug: slug2 }),
    ]);
    expect(across.map((response) => response.status)).toEqual([201, 201]);
  });
});

describe('listing: only what the caller can access', () => {
  let organization: string;
  let owner: Person;
  let admin: Person;
  let creator: Person;
  let member3: Person;
  let member2: Person;
  let viewer: Person;
  let p1: string;
  let p2: string;
  let p3: string;
  let p4: string; // archived

  const list = async (who: Person, query = '') => {
    const response = await call(who).get(`/projects?organizationId=${organization}${query}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return pageOfProjects.parse(response.body);
  };
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id).sort();

  beforeAll(async () => {
    [owner, admin, creator, member3, member2, viewer] = [
      await h.signUp('l-owner'),
      await h.signUp('l-admin'),
      await h.signUp('l-creator'),
      await h.signUp('l-member3'),
      await h.signUp('l-member2'),
      await h.signUp('l-viewer'),
    ];
    organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    for (const [person, role] of [
      [creator, 'member'],
      [member3, 'member'],
      [member2, 'member'],
      [viewer, 'viewer'],
    ] as const)
      await h.addOrganizationMember(owner, organization, person, role);
    // the owner and the admin have NO membership on these projects: their access is implicit
    [p1, p2, p3, p4] = [
      (await createProject(creator, organization, `l-${uid()}`)).id,
      (await createProject(creator, organization, `l-${uid()}`)).id,
      (await createProject(creator, organization, `l-${uid()}`)).id,
      (await createProject(creator, organization, `l-${uid()}`)).id,
    ];
    await call(owner).post(`/projects/${p4}/archive`).expect(200);
    await seedMember(p1, organization, member3, 'project_member');
    await seedMember(p3, organization, member3, 'project_viewer');
    await seedMember(p2, organization, viewer, 'project_viewer');
  });

  it('shows owner and admin every project (implicit access) and member and viewer only the ones they belong to', async () => {
    const all = [p1, p2, p3].sort();
    expect(ids(await list(owner))).toEqual(all);
    expect(ids(await list(admin))).toEqual(all);
    expect(ids(await list(creator))).toEqual(all); // explicit project_admin on each
    expect(ids(await list(member3))).toEqual([p1, p3].sort());
    expect(ids(await list(viewer))).toEqual([p2]);
    expect(ids(await list(member2))).toEqual([]); // belongs to the organization, to no project
  });

  it('counts only accessible projects, and reports the caller explicit role (null for implicit access)', async () => {
    expect((await list(owner)).page.total).toBe(3);
    expect((await list(owner)).items.every((item) => item.projectRole === null)).toBe(true);
    expect((await list(member3)).page.total).toBe(2);
    const roles = Object.fromEntries((await list(member3)).items.map((item) => [item.id, item.projectRole]));
    expect(roles).toEqual({ [p1]: 'project_member', [p3]: 'project_viewer' });
    expect((await list(member2)).page).toEqual({ limit: 20, offset: 0, total: 0 });
  });

  it('combines the status filter with visibility instead of replacing it', async () => {
    expect(ids(await list(owner, '&status=archived'))).toEqual([p4]);
    expect(ids(await list(owner, '&status=all'))).toEqual([p1, p2, p3, p4].sort());
    expect(ids(await list(member3, '&status=all'))).toEqual([p1, p3].sort()); // p4 is archived AND not theirs
    expect(ids(await list(member3, '&status=archived'))).toEqual([]);
    expect(ids(await list(viewer, '&status=all'))).toEqual([p2]);
  });

  it('pages the accessible set only: a hidden project is never counted and a page past the end is empty', async () => {
    const first = await list(member3, '&limit=1&offset=0');
    const second = await list(member3, '&limit=1&offset=1');
    const beyond = await list(member3, '&limit=1&offset=2');
    expect([first.page.total, second.page.total, beyond.page.total]).toEqual([2, 2, 2]); // never 4 or 5
    expect([...ids(first), ...ids(second)].sort()).toEqual([p1, p3].sort());
    expect(beyond.items).toEqual([]);
    expect((await list(member2, '&limit=1&offset=5')).page.total).toBe(0);
  });

  it('ignores memberships of the same person in another organization', async () => {
    const elsewhere = await h.createOrganization(owner, 'Elsewhere');
    await h.addOrganizationMember(owner, elsewhere, member3, 'member');
    const foreignProject = (await createProject(owner, elsewhere, `f-${uid()}`)).id;
    const response = await call(member3).get(`/projects?organizationId=${elsewhere}`);
    expect(response.status).toBe(200);
    expect(pageOfProjects.parse(response.body).items).toEqual([]); // their rows are in the OTHER organization
    expect(ids(await list(member3))).toEqual([p1, p3].sort()); // and the foreign project never shows here
    expect(foreignProject).toBeDefined();
  });

  it('applies a role change on the very next list', async () => {
    const colleague = await h.signUp('l-colleague');
    await h.addOrganizationMember(owner, organization, colleague, 'admin');
    expect(ids(await list(colleague))).toEqual([p1, p2, p3].sort());
    await call(owner)
      .patch(`/organizations/${organization}/members/${colleague.id}`, { role: 'member' })
      .expect(200);
    expect(ids(await list(colleague))).toEqual([]);
    await call(owner).delete(`/organizations/${organization}/members/${colleague.id}`).expect(204);
    expect((await call(colleague).get(`/projects?organizationId=${organization}`)).status).toBe(404);
  });

  it('rejects an absent selector (400), a stranger organization (404) and a bad status (400)', async () => {
    expect((await call(owner).get('/projects')).status).toBe(400);
    expect((await call(owner).get(`/projects?organizationId=${randomUUID()}`)).status).toBe(404);
    expect((await call(owner).get(`/projects?organizationId=${organization}&status=bogus`)).status).toBe(400);
    expect(
      (await call(owner).get(`/projects?organizationId=${organization}&organizationId=${organization}`))
        .status,
    ).toBe(400);
  });
});

describe('tenant isolation: another organization, no membership and no access are one 404', () => {
  let owner: Person;
  let foreignOwner: Person;
  let plainMember: Person;
  let loner: Person;
  let organization: string;
  let project: string;

  beforeAll(async () => {
    [owner, foreignOwner, plainMember, loner] = [
      await h.signUp('iso-owner'),
      await h.signUp('iso-foreign'),
      await h.signUp('iso-member'),
      await h.signUp('iso-loner'),
    ];
    organization = await h.createOrganization(owner, 'Organization with a secret name');
    await h.createOrganization(foreignOwner);
    await h.addOrganizationMember(owner, organization, plainMember, 'member');
    project = (await createProject(owner, organization, 'secret-project', 'Top secret project')).id;
  });

  const routes = (id: string) =>
    [
      ['get', `/projects/${id}`, undefined],
      ['patch', `/projects/${id}`, { name: 'Hijacked' }],
      ['post', `/projects/${id}/archive`, undefined],
      ['post', `/projects/${id}/restore`, undefined],
    ] as const;

  it('answers the identical 404 project_not_found to a foreign owner, to a user in no organization and to a member without access', async () => {
    const seen = new Set<string>();
    for (const [method, path, body] of routes(project))
      for (const caller of [foreignOwner, loner, plainMember]) {
        const response = await call(caller)[method](path, body);
        expect(response.status, `${method} ${path}`).toBe(404);
        const error = errorOf(response.body);
        expect(error.code).toBe('project_not_found');
        seen.add(`${error.code}|${error.message}`);
        expect(JSON.stringify(response.body)).not.toMatch(/secret|Hijacked|Top/i);
      }
    expect(seen.size).toBe(1);
  });

  it('answers that same 404 for a project that does not exist and for a malformed id', async () => {
    const reference = errorOf((await call(foreignOwner).get(`/projects/${project}`)).body);
    for (const id of [randomUUID(), 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])
      for (const [method, path, body] of routes(id)) {
        const response = await call(owner)[method](path, body);
        expect(response.status).toBe(404);
        expect(errorOf(response.body)).toMatchObject({ code: reference.code, message: reference.message });
      }
  });

  it('answers 404 organization_not_found when the organization selector is not the caller own, for list and create', async () => {
    for (const caller of [foreignOwner, loner]) {
      const list = await call(caller).get(`/projects?organizationId=${organization}`);
      const create = await call(caller).post('/projects', {
        organizationId: organization,
        name: 'X',
        slug: 'intruder',
      });
      for (const response of [list, create]) {
        expect(response.status).toBe(404);
        expect(errorOf(response.body).code).toBe('organization_not_found');
        expect(JSON.stringify(response.body)).not.toMatch(/secret/i);
      }
    }
  });

  it('answers 401 without a session on every project route', async () => {
    for (const [method, path, body] of [
      ...routes(project),
      ['get', `/projects?organizationId=${organization}`, undefined] as const,
      ['post', '/projects', { organizationId: organization, name: 'X', slug: 'anon' }] as const,
    ]) {
      const response = await call(undefined)[method](path, body);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(errorOf(response.body).code).toBe('unauthenticated');
    }
  });

  it('changed nothing: the project and its audit trail are untouched by the refused requests', async () => {
    const row = await projectRow(project);
    expect(row).toMatchObject({ name: 'Top secret project', status: 'active', archivedAt: null });
    expect(actionsOf(await auditOf(project))).toEqual(['project.created', 'project_member.added']);
  });
});

describe('the access policy over HTTP: organization role x project role x action', () => {
  /** What the matrix says (ADR-0011 decision 4), written out independently of the code under test. */
  const expectedStatus = (
    org: OrganizationRole,
    projectRole: ProjectRole | null,
    needs: 'read' | 'admin',
  ): number => {
    const implicit = org === 'owner' || org === 'admin';
    if (!implicit && projectRole === null) return 404; // no access: the project does not exist for them
    if (needs === 'read') return 200;
    return implicit || projectRole === 'project_admin' ? 200 : 403;
  };

  it('matches for every organization role and every project role (and none), on read, update, archive and restore', async () => {
    const owner = await h.signUp('mx-owner');
    const organization = await h.createOrganization(owner);
    const people = new Map<OrganizationRole, Person>([['owner', owner]]);
    for (const role of ORGANIZATION_ROLES.filter((r) => r !== 'owner')) {
      const person = await h.signUp(`mx-${role}`);
      await h.addOrganizationMember(owner, organization, person, role);
      people.set(role, person);
    }
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of [null, ...PROJECT_ROLES]) {
        const person = people.get(role)!;
        const project = await seedProject(organization);
        if (projectRole) await seedMember(project, organization, person, projectRole);
        const label = `${role} + ${projectRole}`;
        expect((await call(person).get(`/projects/${project}`)).status, `${label} read`).toBe(
          expectedStatus(role, projectRole, 'read'),
        );
        expect(
          (await call(person).patch(`/projects/${project}`, { name: `By ${role}` })).status,
          `${label} update`,
        ).toBe(expectedStatus(role, projectRole, 'admin'));
        expect((await call(person).post(`/projects/${project}/archive`)).status, `${label} archive`).toBe(
          expectedStatus(role, projectRole, 'admin'),
        );
        expect((await call(person).post(`/projects/${project}/restore`)).status, `${label} restore`).toBe(
          expectedStatus(role, projectRole, 'admin'),
        );
      }
  }, 120_000);

  it('lets an organization viewer who is project_admin of P administer P and nothing else: not the organization, not other projects, not project creation', async () => {
    const owner = await h.signUp('un-owner');
    const viewer = await h.signUp('un-viewer');
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, viewer, 'viewer');
    const [p, other] = [await seedProject(organization), await seedProject(organization)];
    await seedMember(p, organization, viewer, 'project_admin');

    // on P: everything a project admin may do
    expect((await call(viewer).get(`/projects/${p}`)).status).toBe(200);
    expect((await call(viewer).patch(`/projects/${p}`, { name: 'Renamed by a viewer' })).status).toBe(200);
    expect((await call(viewer).post(`/projects/${p}/archive`)).status).toBe(200);
    expect((await call(viewer).post(`/projects/${p}/restore`)).status).toBe(200);
    // on another project of the same organization: it does not exist for them
    for (const response of [
      await call(viewer).get(`/projects/${other}`),
      await call(viewer).patch(`/projects/${other}`, { name: 'No' }),
    ])
      expect([response.status, errorOf(response.body).code]).toEqual([404, 'project_not_found']);
    // at organization level: exactly what a viewer can do, nothing more
    expect((await call(viewer).get(`/organizations/${organization}`)).status).toBe(200);
    expect((await call(viewer).patch(`/organizations/${organization}`, { name: 'Taken over' })).status).toBe(
      403,
    );
    expect((await call(viewer).get(`/organizations/${organization}/members`)).status).toBe(200);
    expect(
      (
        await call(viewer).post(`/organizations/${organization}/members`, {
          email: owner.email,
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(viewer).post('/projects', {
          organizationId: organization,
          name: 'Mine',
          slug: 'viewer-creates',
        })
      ).status,
    ).toBe(403);
    expect(
      pageOfProjects
        .parse((await call(viewer).get(`/projects?organizationId=${organization}`)).body)
        .items.map((item) => item.id),
    ).toEqual([p]);
  });

  it('applies a demotion or a removal on the very next request', async () => {
    const owner = await h.signUp('dm-owner');
    const admin = await h.signUp('dm-admin');
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    const project = await seedProject(organization);
    expect((await call(admin).get(`/projects/${project}`)).status).toBe(200); // implicit access

    await call(owner)
      .patch(`/organizations/${organization}/members/${admin.id}`, { role: 'member' })
      .expect(200);
    expect((await call(admin).get(`/projects/${project}`)).status).toBe(404); // a member with no project role

    await call(owner)
      .patch(`/organizations/${organization}/members/${admin.id}`, { role: 'admin' })
      .expect(200);
    expect((await call(admin).get(`/projects/${project}`)).status).toBe(200);
    await call(owner).delete(`/organizations/${organization}/members/${admin.id}`).expect(204);
    expect((await call(admin).get(`/projects/${project}`)).status).toBe(404);
  });
});

describe('update, archive and restore', () => {
  let owner: Person;
  let organization: string;

  beforeAll(async () => {
    owner = await h.signUp('lc-owner');
    organization = await h.createOrganization(owner);
  });

  it('changes name and description, records field names only, and writes no event when nothing changes', async () => {
    const project = await createProject(owner, organization, `u-${uid()}`, 'Before');
    const changed = await call(owner).patch(`/projects/${project.id}`, {
      name: 'After',
      description: 'now described',
    });
    expect(changed.status).toBe(200);
    expect(projectSchema.parse(changed.body)).toMatchObject({
      name: 'After',
      description: 'now described',
      slug: project.slug,
    });
    expect((await call(owner).patch(`/projects/${project.id}`, { description: null })).status).toBe(200);
    expect((await projectRow(project.id)).description).toBeNull();

    await call(owner).patch(`/projects/${project.id}`, { name: 'After' }).expect(200); // same value: nothing to record
    const updates = (await auditOf(project.id)).filter((event) => event.action === 'project.updated');
    expect(updates.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        { changedFields: ['name', 'description'] },
        { changedFields: ['description'] },
      ]),
    );
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates)).not.toContain('After');
  });

  it('cannot change the organization or the slug: not through the API, and not through the contract', async () => {
    const project = await createProject(owner, organization, `fixed-${uid()}`);
    for (const body of [
      { slug: 'new-slug' },
      { organizationId: randomUUID() },
      { name: 'X', slug: 'new-slug' },
      {},
    ])
      expect((await call(owner).patch(`/projects/${project.id}`, body)).status).toBe(400);
    expect(await projectRow(project.id)).toMatchObject({ slug: project.slug, organizationId: organization });
  });

  it('archives and restores idempotently: the same body, 200 every time, one event per real change', async () => {
    const project = await createProject(owner, organization, `idem-${uid()}`);
    const first = await call(owner).post(`/projects/${project.id}/archive`);
    expect(first.status).toBe(200);
    const archived = projectSchema.parse(first.body);
    expect(archived).toMatchObject({ status: 'archived' });
    expect(archived.archivedAt).not.toBeNull();

    const again = await call(owner).post(`/projects/${project.id}/archive`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body); // archivedAt and updatedAt did not move
    expect(
      actionsOf(await auditOf(project.id)).filter((action) => action === 'project.archived'),
    ).toHaveLength(1);

    const restored = await call(owner).post(`/projects/${project.id}/restore`);
    expect(restored.status).toBe(200);
    expect(projectSchema.parse(restored.body)).toMatchObject({ status: 'active', archivedAt: null });
    const restoredAgain = await call(owner).post(`/projects/${project.id}/restore`);
    expect(restoredAgain.status).toBe(200);
    expect(restoredAgain.body).toEqual(restored.body);
    const actions = actionsOf(await auditOf(project.id));
    expect(actions.filter((action) => action === 'project.restored')).toHaveLength(1);
    expect(actions.filter((action) => action === 'project.archived')).toHaveLength(1);
  });

  it('writes exactly one event when many archives or restores arrive at the same time', async () => {
    const project = await createProject(owner, organization, `many-${uid()}`);
    const archives = await Promise.all(
      Array.from({ length: 8 }, () => call(owner).post(`/projects/${project.id}/archive`)),
    );
    expect(archives.map((response) => response.status)).toEqual(Array(8).fill(200));
    expect(new Set(archives.map((response) => JSON.stringify(response.body))).size).toBe(1);
    const restores = await Promise.all(
      Array.from({ length: 8 }, () => call(owner).post(`/projects/${project.id}/restore`)),
    );
    expect(restores.map((response) => response.status)).toEqual(Array(8).fill(200));
    const actions = actionsOf(await auditOf(project.id));
    expect(actions.filter((action) => action === 'project.archived')).toHaveLength(1);
    expect(actions.filter((action) => action === 'project.restored')).toHaveLength(1);
  });

  it('makes an archived project read-only (409 project_archived) until it is restored, and keeps it readable', async () => {
    const project = await createProject(owner, organization, `ro-${uid()}`, 'Read only');
    await call(owner).post(`/projects/${project.id}/archive`).expect(200);
    const refused = await call(owner).patch(`/projects/${project.id}`, { name: 'Changed' });
    expect([refused.status, errorOf(refused.body).code]).toEqual([409, 'project_archived']);
    expect((await projectRow(project.id)).name).toBe('Read only');
    expect((await call(owner).get(`/projects/${project.id}`)).status).toBe(200);
    await call(owner).post(`/projects/${project.id}/restore`).expect(200);
    expect((await call(owner).patch(`/projects/${project.id}`, { name: 'Changed' })).status).toBe(200);
  });
});

describe('every change commits together with its audit events', () => {
  it('rolls creation, update, archive and restore back when the audit trail cannot be written', async () => {
    const owner = await h.signUp('at-owner');
    const organization = await h.createOrganization(owner);
    const project = await createProject(owner, organization, `at-${uid()}`, 'Before');
    const archivedProject = await createProject(owner, organization, `at2-${uid()}`, 'Archived one');
    await call(owner).post(`/projects/${archivedProject.id}/archive`).expect(200);
    const broken = await h.createApp({ failingAudit: true });
    try {
      const projects = await h.inspector.project.count();
      const members = await h.inspector.projectMember.count();
      const events = await h.inspector.auditLog.count();
      const as = (path: string, method: 'post' | 'patch', body?: unknown) =>
        h.as(owner.token, broken)[method](path, body);

      const responses = [
        await as('/projects', 'post', { organizationId: organization, name: 'Never', slug: 'never-created' }),
        await as(`/projects/${project.id}`, 'patch', { name: 'Never either' }),
        await as(`/projects/${project.id}/archive`, 'post'),
        await as(`/projects/${archivedProject.id}/restore`, 'post'),
      ];
      for (const response of responses) {
        expect(response.status).toBe(500);
        expect(JSON.stringify(response.body)).not.toMatch(/audit store/);
      }
      expect(await h.inspector.project.count()).toBe(projects); // creation left no project...
      expect(await h.inspector.projectMember.count()).toBe(members); // ...and no creator membership
      expect(await h.inspector.auditLog.count()).toBe(events);
      expect(await projectRow(project.id)).toMatchObject({
        name: 'Before',
        status: 'active',
        archivedAt: null,
      });
      expect((await projectRow(archivedProject.id)).status).toBe('archived');
    } finally {
      await broken.close();
    }
  });
});

describe('the accepted in-flight actor window (ADR-0011 Q13, variant V1)', () => {
  it('lets a request that is past its transactional authorization complete while the actor is demoted, and denies every later request', async () => {
    const owner = await h.signUp('w-owner');
    const admin = await h.signUp('w-admin');
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    const project = await createProject(owner, organization, `w-${uid()}`, 'Before');

    // Hold the admin's update INSIDE its transaction (after it authorized the admin under the project lock, before it commits).
    let reached!: () => void;
    const inFlight = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const slow = await h.createApp({
      beforeAudit: async (entry) => {
        if (entry.action !== 'project.updated') return;
        reached();
        await hold;
      },
    });
    try {
      const pending = h
        .as(admin.token, slow)
        .patch(`/projects/${project.id}`, { name: 'Changed while being demoted' })
        .then((response) => response);
      await inFlight; // the update is authorized and waiting to be recorded

      // The organization side is NOT blocked by it: the demotion commits while the update is in flight (no lock is shared with it).
      const demoted = await call(owner).patch(`/organizations/${organization}/members/${admin.id}`, {
        role: 'member',
      });
      expect(demoted.status).toBe(200);

      release();
      const finished = await pending;
      expect(finished.status).toBe(200); // THE WINDOW: authorized at its transactional check, completes after the demotion
      expect((await projectRow(project.id)).name).toBe('Changed while being demoted');
    } finally {
      release();
      await slow.close();
    }

    // ...but once the demotion is visible, every subsequent request fails
    expect((await call(admin).get(`/projects/${project.id}`)).status).toBe(404);
    expect((await call(admin).patch(`/projects/${project.id}`, { name: 'Again' })).status).toBe(404);
    expect((await projectRow(project.id)).name).toBe('Changed while being demoted');
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds the NEXT project update inside its transaction, at the same synchronization point as the actor-window test above: after the
 * update has authorized its actor under the project lock and written the row, before it records its audit event and commits.
 */
function holdProjectUpdate() {
  let reached!: () => void;
  const inFlight = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return {
    inFlight,
    release,
    options: {
      beforeAudit: async (entry: { action: string }) => {
        if (entry.action !== 'project.updated') return;
        reached();
        await held;
      },
    },
  };
}

const orphanProjectMembers = async () =>
  Number(
    (
      await h.inspector.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM projects.project_member pm WHERE NOT EXISTS (SELECT 1 FROM identity.membership m WHERE m.organization_id = pm.organization_id AND m.user_id = pm.user_id)`,
      )
    )[0]?.n,
  );

describe('the in-flight actor window with an EXPLICIT project membership (ADR-0011 Q13, variant V1)', () => {
  it('Test 1: an update in flight completes when its admin actor is demoted to viewer, and the explicit project_admin role keeps project access but restores no organization privilege', async () => {
    const owner = await h.signUp('w1-owner');
    const actor = await h.signUp('w1-actor');
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, actor, 'admin');
    const project = await createProject(actor, organization, `w1-${uid()}`, 'Before'); // the creator holds an explicit project_admin row
    expect(
      (await h.inspector.projectMember.findMany({ where: { projectId: project.id, userId: actor.id } })).map(
        (row) => row.role,
      ),
    ).toEqual(['project_admin']);

    const hold = holdProjectUpdate();
    const slow = await h.createApp(hold.options);
    try {
      const pending = h
        .as(actor.token, slow)
        .patch(`/projects/${project.id}`, { name: 'Changed while being demoted' })
        .then((response) => response);
      await hold.inFlight; // authorized as organization ADMIN + explicit project_admin, waiting to be recorded

      const demoted = await call(owner).patch(`/organizations/${organization}/members/${actor.id}`, {
        role: 'viewer',
      });
      expect(demoted.status).toBe(200); // the organization side is not blocked by the update in flight

      hold.release();
      const finished = await pending;
      expect(finished.status).toBe(200); // THE WINDOW: authorized before the demotion, completes after it
      expect((await projectRow(project.id)).name).toBe('Changed while being demoted');
    } finally {
      hold.release();
      await slow.close();
    }

    // The demotion is now visible. The explicit membership still stands, so project access does NOT disappear (no 404 here) ...
    const read = await call(actor).get(`/projects/${project.id}`);
    expect(read.status).toBe(200);
    expect(projectSchema.parse(read.body)).toMatchObject({
      projectRole: 'project_admin',
      name: 'Changed while being demoted',
    });
    expect((await call(actor).patch(`/projects/${project.id}`, { name: 'Still administered' })).status).toBe(
      200,
    ); // project-level write
    expect((await call(actor).post(`/projects/${project.id}/archive`)).status).toBe(200);
    expect((await call(actor).post(`/projects/${project.id}/restore`)).status).toBe(200);
    expect(
      pageOfProjects
        .parse((await call(actor).get(`/projects?organizationId=${organization}`)).body)
        .items.map((item) => item.id),
    ).toEqual([project.id]);

    // ... but nothing at ORGANIZATION level comes back with it: the organization role is now viewer
    const create = await call(actor).post('/projects', {
      organizationId: organization,
      name: 'Another',
      slug: `w1b-${uid()}`,
    });
    expect([create.status, errorOf(create.body).code]).toEqual([403, 'forbidden']);
    expect((await call(actor).patch(`/organizations/${organization}`, { name: 'Taken over' })).status).toBe(
      403,
    );
    expect(
      (
        await call(actor).post(`/organizations/${organization}/members`, {
          email: owner.email,
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    expect((await call(actor).get(`/organizations/${organization}`)).status).toBe(200); // what a viewer may do
    expect(await h.inspector.project.count({ where: { organizationId: organization } })).toBe(1); // no second project was created
  });

  it('Test 2: an update in flight when its actor is REMOVED from the organization — measured: does the removal wait, what survives, what the next request sees', async () => {
    const owner = await h.signUp('w2-owner');
    const actor = await h.signUp('w2-actor');
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, actor, 'member');
    const project = await createProject(owner, organization, `w2-${uid()}`, 'Before');
    const second = await createProject(owner, organization, `w2b-${uid()}`, 'Second');
    expect(
      (
        await call(owner).post(`/projects/${project.id}/members`, {
          userId: actor.id,
          projectRole: 'project_admin',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(owner).post(`/projects/${second.id}/members`, {
          userId: actor.id,
          projectRole: 'project_viewer',
        })
      ).status,
    ).toBe(201);
    await call(owner).post(`/projects/${second.id}/archive`).expect(200); // the cleanup must also reach an archived project

    const hold = holdProjectUpdate();
    const slow = await h.createApp(hold.options);
    let removalWaitedForTheUpdate: boolean;
    let updated: { status: number };
    let removed: { status: number };
    try {
      const pending = h
        .as(actor.token, slow)
        .patch(`/projects/${project.id}`, { name: 'Changed while being removed' })
        .then((response) => response);
      await hold.inFlight; // authorized as organization MEMBER + explicit project_admin, holding the project row, waiting to be recorded

      let removalSettled = false;
      const removal = call(owner)
        .delete(`/organizations/${organization}/members/${actor.id}`)
        .then((response) => {
          removalSettled = true;
          return response;
        });
      await sleep(2000); // far longer than a removal takes when nothing blocks it (tens of milliseconds)
      removalWaitedForTheUpdate = !removalSettled;

      hold.release();
      [updated, removed] = [await pending, await removal];
    } finally {
      hold.release();
      await slow.close();
    }

    // MEASURED: the removal did NOT wait for the update in flight. (The update holds only the project row; the removal takes the owner rows,
    // the removed member's membership row and deletes project_member rows, which do not conflict with a lock on the PROJECT row.)
    expect(removalWaitedForTheUpdate).toBe(false);
    expect(removed.status).toBe(204);
    expect(updated.status).toBe(200); // THE WINDOW for a removal: the update was authorized before the removal and completes after it
    expect((await projectRow(project.id)).name).toBe('Changed while being removed');

    // the cleanup was atomic with the removal: no membership, no project membership of the actor anywhere, no orphan
    expect(
      await h.inspector.membership.count({ where: { organizationId: organization, userId: actor.id } }),
    ).toBe(0);
    expect(
      await h.inspector.projectMember.count({ where: { organizationId: organization, userId: actor.id } }),
    ).toBe(0);
    expect(await orphanProjectMembers()).toBe(0);
    for (const [target, role] of [
      [project, 'project_admin'],
      [second, 'project_viewer'],
    ] as const) {
      const cleanup = (await auditOf(target.id)).filter(
        (entry) =>
          entry.action === 'project_member.removed' &&
          (entry.metadata as { userId: string }).userId === actor.id,
      );
      expect(cleanup, target.id).toHaveLength(1);
      expect(cleanup[0]!.metadata).toEqual({
        userId: actor.id,
        role,
        reason: 'organization_membership_removed',
      });
      expect(cleanup[0]!.actorUserId).toBe(owner.id);
    }
    // the in-flight update recorded its own event, attributed to the actor who was authorized when it started
    expect(
      (await auditOf(project.id)).filter(
        (entry) => entry.action === 'project.updated' && entry.actorUserId === actor.id,
      ),
    ).toHaveLength(1);

    // every NEW request now sees the removal: the generic 404 (and the organization is no longer theirs)
    for (const response of [
      await call(actor).get(`/projects/${project.id}`),
      await call(actor).patch(`/projects/${project.id}`, { name: 'Again' }),
      await call(actor).get(`/projects/${second.id}`),
      await call(actor).get(`/projects/${project.id}/members`),
    ]) {
      expect(response.status).toBe(404);
      expect(errorOf(response.body).code).toBe('project_not_found');
    }
    const list = await call(actor).get(`/projects?organizationId=${organization}`);
    expect([list.status, errorOf(list.body).code]).toEqual([404, 'organization_not_found']);
    expect((await projectRow(project.id)).name).toBe('Changed while being removed'); // the refused requests changed nothing
  });
});

describe('removing an explicit project membership recalculates access from the organization role alone', () => {
  it('Test 3: a member and a viewer lose the project (404), an admin keeps it through the organization role (projectRole null), and organization-level rights are untouched', async () => {
    const [owner, member, viewer, admin] = [
      await h.signUp('x3-owner'),
      await h.signUp('x3-member'),
      await h.signUp('x3-viewer'),
      await h.signUp('x3-admin'),
    ];
    const organization = await h.createOrganization(owner);
    for (const [person, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
      [admin, 'admin'],
    ] as const)
      await h.addOrganizationMember(owner, organization, person, role);
    const project = await createProject(owner, organization, `x3-${uid()}`);
    for (const [person, role] of [
      [member, 'project_member'],
      [viewer, 'project_viewer'],
      [admin, 'project_admin'],
    ] as const)
      expect(
        (await call(owner).post(`/projects/${project.id}/members`, { userId: person.id, projectRole: role }))
          .status,
      ).toBe(201);

    // before: all three reach the project, and report their EXPLICIT role
    const roleBefore = async (person: Person) => {
      const response = await call(person).get(`/projects/${project.id}`);
      expect(response.status).toBe(200);
      return projectSchema.parse(response.body).projectRole;
    };
    expect([await roleBefore(member), await roleBefore(viewer), await roleBefore(admin)]).toEqual([
      'project_member',
      'project_viewer',
      'project_admin',
    ]);

    for (const person of [member, viewer, admin])
      expect((await call(owner).delete(`/projects/${project.id}/members/${person.id}`)).status).toBe(204);
    for (const person of [member, viewer, admin])
      // only the explicit rows went; the organization memberships are untouched
      expect(
        await h.inspector.membership.count({ where: { organizationId: organization, userId: person.id } }),
      ).toBe(1);

    // A. an organization member and viewer: no explicit membership and no implicit access = the project no longer exists for them
    for (const person of [member, viewer]) {
      for (const response of [
        await call(person).get(`/projects/${project.id}`),
        await call(person).get(`/projects/${project.id}/members`),
        await call(person).patch(`/projects/${project.id}`, { name: 'Nope' }),
      ]) {
        expect(response.status).toBe(404);
        expect(errorOf(response.body).code).toBe('project_not_found');
      }
      const list = await call(person).get(`/projects?organizationId=${organization}`);
      expect(list.status).toBe(200);
      expect(pageOfProjects.parse(list.body)).toMatchObject({ items: [], page: { total: 0 } });
    }

    // B. an organization admin: implicit access through the organization role, with no explicit role to report
    const read = await call(admin).get(`/projects/${project.id}`);
    expect(read.status).toBe(200);
    expect(projectSchema.parse(read.body).projectRole).toBeNull();
    expect((await call(admin).patch(`/projects/${project.id}`, { name: 'Implicit admin' })).status).toBe(200);
    expect(
      pageOfProjects
        .parse((await call(admin).get(`/projects?organizationId=${organization}`)).body)
        .items.map((item) => [item.id, item.projectRole]),
    ).toEqual([[project.id, null]]);

    // organization-level permissions are still exactly those of the organization role
    expect(
      (await call(admin).patch(`/organizations/${organization}`, { name: 'Renamed by the admin' })).status,
    ).toBe(200); // admin: organization.update
    const viewerCreate = await call(viewer).post('/projects', {
      organizationId: organization,
      name: 'V',
      slug: `x3v-${uid()}`,
    });
    expect([viewerCreate.status, errorOf(viewerCreate.body).code]).toEqual([403, 'forbidden']); // viewer: no project.create
    expect(
      (
        await call(member).post('/projects', {
          organizationId: organization,
          name: 'M',
          slug: `x3m-${uid()}`,
        })
      ).status,
    ).toBe(201); // member: project.create
    expect((await call(viewer).get(`/organizations/${organization}`)).status).toBe(200);
    expect((await call(member).patch(`/organizations/${organization}`, { name: 'Taken' })).status).toBe(403);
  });
});
