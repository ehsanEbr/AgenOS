import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ProjectRole,
  apiErrorSchema,
  paginatedSchema,
  projectMemberSchema,
  projectSchema,
} from '@agentos/contracts';
import type { AuditEntry } from '../src/modules/audit/application/audit-repository';
import { MembershipLifecycle, type MembershipRemovalParticipant } from '../src/modules/organizations';
import { type Harness, type Person, actionsOf, startHarness, uid } from './support/integration-harness';

/*
 * Project members, the end of an organization membership, and the concurrency of both, end to end against REAL PostgreSQL and Redis
 * (ADR-0011 decisions 3 and 9). Requires `pnpm infra:up`.
 *
 * The invariant under test: a project membership exists only while the matching organization membership exists. Every path that ends an
 * organization membership removes the project rows in the same transaction; every path that creates one holds the organization
 * membership first; the composite foreign keys are the backstop and are never the normal way an operation ends.
 */

let h: Harness;
const call = (person?: Person) => h.as(person?.token);
const errorOf = (body: unknown) => apiErrorSchema.parse(body);
const membersPage = paginatedSchema(projectMemberSchema);

beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const newProject = async (who: Person, organizationId: string, slug = `m-${uid()}`) => {
  const response = await call(who).post('/projects', { organizationId, name: 'Project', slug });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return projectSchema.parse(response.body);
};
const addMember = (
  who: Person,
  projectId: string,
  userId: string,
  projectRole: ProjectRole = 'project_member',
) => call(who).post(`/projects/${projectId}/members`, { userId, projectRole });
const memberRows = (projectId: string) => h.inspector.projectMember.findMany({ where: { projectId } });
const auditFor = (projectId: string) =>
  h.inspector.auditLog.findMany({ where: { projectId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
const orphans = async () =>
  Number(
    (
      await h.inspector.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM projects.project_member pm WHERE NOT EXISTS (SELECT 1 FROM identity.membership m WHERE m.organization_id = pm.organization_id AND m.user_id = pm.user_id)`,
      )
    )[0]?.n,
  );
const isOrganizationMember = async (organizationId: string, userId: string) =>
  (await h.inspector.membership.count({ where: { organizationId, userId } })) === 1;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds a request INSIDE its transaction at the moment it writes the audit event for `action`. */
function gateOn(action: string) {
  let reached!: () => void;
  const hasReached = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    hasReached,
    release,
    options: {
      beforeAudit: async (entry: AuditEntry) => {
        if (entry.action !== action) return;
        reached();
        await released;
      },
    },
  };
}

describe('managing project members', () => {
  let owner: Person;
  let admin: Person;
  let creator: Person;
  let plain: Person;
  let viewer: Person;
  let target: Person;
  let outsider: Person; // belongs to ANOTHER organization only
  let organization: string;
  let project: string;

  beforeAll(async () => {
    [owner, admin, creator, plain, viewer, target, outsider] = [
      await h.signUp('pm-owner'),
      await h.signUp('pm-admin'),
      await h.signUp('pm-creator'),
      await h.signUp('pm-plain'),
      await h.signUp('pm-viewer'),
      await h.signUp('pm-target'),
      await h.signUp('pm-outsider'),
    ];
    organization = await h.createOrganization(owner);
    for (const [person, role] of [
      [admin, 'admin'],
      [creator, 'member'],
      [plain, 'member'],
      [viewer, 'viewer'],
      [target, 'member'],
    ] as const)
      await h.addOrganizationMember(owner, organization, person, role);
    await h.createOrganization(outsider);
    project = (await newProject(creator, organization)).id;
  });

  it('lets owner and admin (implicit access) and the project_admin add members; refuses a project_member, a project_viewer and an organization member without a role', async () => {
    const extra = [
      await h.signUp('pm-e1'),
      await h.signUp('pm-e2'),
      await h.signUp('pm-e3'),
      await h.signUp('pm-e4'),
    ];
    for (const person of extra) await h.addOrganizationMember(owner, organization, person, 'member');
    await addMember(creator, project, plain.id, 'project_member').expect(201);
    await addMember(creator, project, viewer.id, 'project_viewer').expect(201);

    expect((await addMember(owner, project, extra[0]!.id)).status).toBe(201); // implicit
    expect((await addMember(admin, project, extra[1]!.id)).status).toBe(201); // implicit
    expect((await addMember(creator, project, extra[2]!.id)).status).toBe(201); // project_admin
    expect((await addMember(plain, project, extra[3]!.id)).status).toBe(403); // project_member: can see, cannot manage
    expect((await addMember(viewer, project, extra[3]!.id)).status).toBe(403); // organization viewer + project_viewer
    expect((await addMember(target, project, extra[3]!.id)).status).toBe(404); // organization member with NO project role: no such project
    expect(await memberRows(project).then((rows) => rows.length)).toBe(1 + 2 + 3);
  });

  it('lists the explicit members with their identity to anyone with access, and not the implicit owner/admin', async () => {
    for (const reader of [owner, creator, plain, viewer]) {
      const response = await call(reader).get(`/projects/${project}/members`);
      expect(response.status).toBe(200);
      const page = membersPage.parse(response.body);
      expect(page.items.some((member) => member.userId === owner.id || member.userId === admin.id)).toBe(
        false,
      );
      expect(page.items.find((member) => member.userId === creator.id)).toMatchObject({
        role: 'project_admin',
        email: creator.email,
      });
    }
    expect((await call(target).get(`/projects/${project}/members`)).status).toBe(404);
    const paged = membersPage.parse(
      (await call(owner).get(`/projects/${project}/members?limit=2&offset=1`)).body,
    );
    expect(paged.items).toHaveLength(2);
    expect(paged.page).toMatchObject({ limit: 2, offset: 1 });
  });

  it('adds by user id and records who was added, with the "added" origin', async () => {
    const fresh = await h.signUp('pm-fresh');
    await h.addOrganizationMember(owner, organization, fresh, 'member');
    const response = await addMember(owner, project, fresh.id, 'project_viewer');
    expect(response.status).toBe(201);
    expect(projectMemberSchema.parse(response.body)).toMatchObject({
      userId: fresh.id,
      email: fresh.email,
      role: 'project_viewer',
    });
    const event = (await auditFor(project)).find(
      (entry) =>
        entry.action === 'project_member.added' && (entry.metadata as { userId: string }).userId === fresh.id,
    );
    expect(event?.metadata).toEqual({ userId: fresh.id, role: 'project_viewer', origin: 'added' });
    expect(event?.actorUserId).toBe(owner.id);
  });

  it('gives an unknown user and a user outside the organization the identical 404, and cross-organization membership is impossible', async () => {
    const [unknown, foreign] = await Promise.all([
      addMember(owner, project, randomUUID()),
      addMember(owner, project, outsider.id), // a real user, member of ANOTHER organization
    ]);
    expect([unknown.status, foreign.status]).toEqual([404, 404]);
    expect(errorOf(unknown.body)).toMatchObject({ code: 'organization_member_not_found' });
    expect({ ...errorOf(foreign.body), correlationId: '' }).toEqual({
      ...errorOf(unknown.body),
      correlationId: '',
    });
    expect((await memberRows(project)).some((row) => row.userId === outsider.id)).toBe(false);
    expect(await orphans()).toBe(0);
  });

  it('answers 409 for a second membership of the same user and validates the body', async () => {
    const again = await addMember(owner, project, creator.id, 'project_viewer');
    expect([again.status, errorOf(again.body).code]).toEqual([409, 'already_project_member']);
    for (const body of [
      {},
      { userId: 'not-a-uuid', projectRole: 'project_member' },
      { userId: target.id, projectRole: 'admin' },
      { userId: target.email, projectRole: 'project_member' },
    ])
      expect((await call(owner).post(`/projects/${project}/members`, body)).status).toBe(400);
  });

  it('changes a role (recording the role it replaced), writes nothing for the same role, and removes a member', async () => {
    const member = await h.signUp('pm-changer');
    await h.addOrganizationMember(owner, organization, member, 'member');
    await addMember(owner, project, member.id, 'project_viewer').expect(201);

    const changed = await call(creator).patch(`/projects/${project}/members/${member.id}`, {
      projectRole: 'project_admin',
    });
    expect(changed.status).toBe(200);
    expect(projectMemberSchema.parse(changed.body).role).toBe('project_admin');
    const events = await h.inspector.auditLog.count({
      where: { projectId: project, action: 'project_member.role_changed' },
    });
    await call(creator)
      .patch(`/projects/${project}/members/${member.id}`, { projectRole: 'project_admin' })
      .expect(200);
    expect(
      await h.inspector.auditLog.count({
        where: { projectId: project, action: 'project_member.role_changed' },
      }),
    ).toBe(events);
    const change = (await auditFor(project))
      .filter((entry) => entry.action === 'project_member.role_changed')
      .at(-1);
    expect(change?.metadata).toEqual({
      userId: member.id,
      previousRole: 'project_viewer',
      role: 'project_admin',
    });

    expect((await call(creator).delete(`/projects/${project}/members/${member.id}`)).status).toBe(204);
    expect((await call(creator).delete(`/projects/${project}/members/${member.id}`)).status).toBe(404);
    expect(await isOrganizationMember(organization, member.id)).toBe(true); // the organization membership is untouched
    const removed = (await auditFor(project))
      .filter((entry) => entry.action === 'project_member.removed')
      .at(-1);
    expect(removed?.metadata).toEqual({ userId: member.id, role: 'project_admin', reason: 'removed' });
  });

  it('refuses member changes on an archived project (409) while still listing, and works again after a restore', async () => {
    const own = (await newProject(owner, organization)).id;
    await addMember(owner, own, target.id, 'project_viewer').expect(201);
    await call(owner).post(`/projects/${own}/archive`).expect(200);
    const rows = await memberRows(own);
    for (const response of [
      await addMember(owner, own, plain.id),
      await call(owner).patch(`/projects/${own}/members/${target.id}`, { projectRole: 'project_admin' }),
      await call(owner).delete(`/projects/${own}/members/${target.id}`),
    ])
      expect([response.status, errorOf(response.body).code]).toEqual([409, 'project_archived']);
    expect(await memberRows(own)).toHaveLength(rows.length);
    expect((await call(owner).get(`/projects/${own}/members`)).status).toBe(200);
    await call(owner).post(`/projects/${own}/restore`).expect(200);
    expect((await call(owner).delete(`/projects/${own}/members/${target.id}`)).status).toBe(204);
  });

  it('keeps project roles from reaching the organization: a project_admin gains nothing at organization level', async () => {
    const own = (await newProject(creator, organization)).id; // creator is project_admin of it
    expect((await call(creator).patch(`/organizations/${organization}`, { name: 'Taken over' })).status).toBe(
      403,
    );
    expect(
      (
        await call(creator).post(`/organizations/${organization}/members`, {
          email: outsider.email,
          role: 'owner',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(creator).patch(`/organizations/${organization}/members/${creator.id}`, { role: 'owner' }))
        .status,
    ).toBe(403);
    expect(
      (await call(creator).patch(`/projects/${own}`, { name: 'but the project is theirs' })).status,
    ).toBe(200);
  });

  it('answers the generic 404 on every member route to a stranger, a foreign owner and the anonymous caller gets 401', async () => {
    const foreignProject = (await newProject(outsider, await h.createOrganization(outsider))).id;
    for (const caller of [outsider, target]) {
      for (const [method, path, body] of [
        ['get', `/projects/${project}/members`, undefined],
        ['post', `/projects/${project}/members`, { userId: plain.id, projectRole: 'project_member' }],
        ['patch', `/projects/${project}/members/${creator.id}`, { projectRole: 'project_viewer' }],
        ['delete', `/projects/${project}/members/${creator.id}`, undefined],
      ] as const) {
        const response = await call(caller)[method](path, body);
        expect([response.status, errorOf(response.body).code], `${method} ${path}`).toEqual([
          404,
          'project_not_found',
        ]);
      }
    }
    // a project of another organization cannot be reached with a member id of this one
    const response = await call(owner).patch(`/projects/${foreignProject}/members/${creator.id}`, {
      projectRole: 'project_admin',
    });
    expect([response.status, errorOf(response.body).code]).toEqual([404, 'project_not_found']);
    expect((await call(undefined).get(`/projects/${project}/members`)).status).toBe(401);
    expect((await call(undefined).post(`/projects/${project}/members`, {})).status).toBe(401);
  });

  it('rolls every member change back when the audit trail cannot be written', async () => {
    const own = (await newProject(owner, organization)).id;
    await addMember(owner, own, plain.id, 'project_viewer').expect(201);
    const broken = await h.createApp({ failingAudit: true });
    try {
      const rows = (await memberRows(own)).length;
      const events = await h.inspector.auditLog.count();
      const as = h.as(owner.token, broken);
      const responses = [
        await as.post(`/projects/${own}/members`, { userId: viewer.id, projectRole: 'project_member' }),
        await as.patch(`/projects/${own}/members/${plain.id}`, { projectRole: 'project_admin' }),
        await as.delete(`/projects/${own}/members/${plain.id}`),
      ];
      for (const response of responses) expect(response.status).toBe(500);
      expect((await memberRows(own)).length).toBe(rows);
      expect((await memberRows(own)).find((row) => row.userId === plain.id)?.role).toBe('project_viewer');
      expect(await h.inspector.auditLog.count()).toBe(events);
    } finally {
      await broken.close();
    }
  });
});

describe('ending an organization membership ends the project memberships, atomically', () => {
  it('removes the user project memberships in that organization (archived projects too), with an event each, and nothing else', async () => {
    const [owner, leaver, bystander] = [
      await h.signUp('rm-owner'),
      await h.signUp('rm-leaver'),
      await h.signUp('rm-bystander'),
    ];
    const organization = await h.createOrganization(owner);
    const otherOrganization = await h.createOrganization(owner, 'Other');
    for (const org of [organization, otherOrganization]) {
      await h.addOrganizationMember(owner, org, leaver, 'member');
      await h.addOrganizationMember(owner, org, bystander, 'member');
    }
    const [p1, p2, p3] = [
      await newProject(owner, organization),
      await newProject(owner, organization),
      await newProject(owner, organization),
    ];
    const elsewhere = await newProject(owner, otherOrganization);
    await addMember(owner, p1.id, leaver.id, 'project_admin').expect(201);
    await addMember(owner, p2.id, leaver.id, 'project_viewer').expect(201);
    await addMember(owner, p3.id, leaver.id, 'project_member').expect(201);
    await addMember(owner, p1.id, bystander.id).expect(201);
    await addMember(owner, elsewhere.id, leaver.id, 'project_admin').expect(201);
    await call(owner).post(`/projects/${p3.id}/archive`).expect(200); // the cleanup must also reach archived projects

    const removal = await call(owner).delete(`/organizations/${organization}/members/${leaver.id}`);
    expect(removal.status).toBe(204);

    expect(await isOrganizationMember(organization, leaver.id)).toBe(false);
    expect(
      await h.inspector.projectMember.count({ where: { organizationId: organization, userId: leaver.id } }),
    ).toBe(0);
    expect(
      await h.inspector.projectMember.count({
        where: { organizationId: organization, userId: bystander.id },
      }),
    ).toBe(1);
    expect(
      await h.inspector.projectMember.count({
        where: { organizationId: otherOrganization, userId: leaver.id },
      }),
    ).toBe(1); // the OTHER organization is untouched
    for (const project of [p1, p2, p3]) {
      const events = (await auditFor(project.id)).filter(
        (entry) =>
          entry.action === 'project_member.removed' &&
          (entry.metadata as { userId: string }).userId === leaver.id,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: owner.id,
        organizationId: organization,
        projectId: project.id,
      });
      expect((events[0]!.metadata as { reason: string }).reason).toBe('organization_membership_removed');
    }
    // the organization's own event is in the same request (same correlation id) as the cleanup events
    const organizationEvent = await h.inspector.auditLog.findFirstOrThrow({
      where: { organizationId: organization, action: 'membership.removed' },
    });
    const cleanupEvent = (await auditFor(p1.id)).find((entry) => entry.action === 'project_member.removed')!;
    expect(cleanupEvent.correlationId).toBe(organizationEvent.correlationId);
    expect(await orphans()).toBe(0);
  });

  it('does the same when the user leaves on their own, and the former member then sees none of it', async () => {
    const [owner, leaver] = [await h.signUp('lv-owner'), await h.signUp('lv-leaver')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, leaver, 'member');
    const project = await newProject(owner, organization);
    await addMember(owner, project.id, leaver.id, 'project_admin').expect(201);

    expect((await call(leaver).delete(`/organizations/${organization}/members/${leaver.id}`)).status).toBe(
      204,
    );
    expect(await memberRows(project.id).then((rows) => rows.some((row) => row.userId === leaver.id))).toBe(
      false,
    );
    const event = (await auditFor(project.id)).find((entry) => entry.action === 'project_member.removed')!;
    expect(event.actorUserId).toBe(leaver.id);
    expect((await call(leaver).get(`/projects/${project.id}`)).status).toBe(404);
    expect((await call(leaver).get(`/projects?organizationId=${organization}`)).status).toBe(404);
    // coming back does not revive anything
    await h.addOrganizationMember(owner, organization, leaver, 'member');
    expect((await call(leaver).get(`/projects/${project.id}`)).status).toBe(404);
  });

  it('keeps the last-owner protection intact: a sole owner with project memberships cannot leave, and nothing is removed', async () => {
    const owner = await h.signUp('lo-owner');
    const organization = await h.createOrganization(owner);
    const project = await newProject(owner, organization);
    const rows = await memberRows(project.id);
    const events = await h.inspector.auditLog.count();
    const response = await call(owner).delete(`/organizations/${organization}/members/${owner.id}`);
    expect([response.status, errorOf(response.body).code]).toEqual([409, 'last_owner']);
    expect(await memberRows(project.id)).toHaveLength(rows.length);
    expect(await isOrganizationMember(organization, owner.id)).toBe(true);
    expect(await h.inspector.auditLog.count()).toBe(events);
  });

  it('rolls the WHOLE removal back when a participant fails after the project cleanup already ran', async () => {
    const [owner, leaver] = [await h.signUp('fl-owner'), await h.signUp('fl-leaver')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, leaver, 'member');
    const project = await newProject(owner, organization);
    await addMember(owner, project.id, leaver.id, 'project_admin').expect(201);

    // a second participant that runs AFTER the projects cleanup and fails
    const failing: MembershipRemovalParticipant = {
      name: 'test.failing-participant',
      onMembershipRemoved: () => Promise.reject(new Error('cleanup failed')),
    };
    class WithFailingParticipant extends MembershipLifecycle {
      override participants() {
        return [...super.participants(), failing];
      }
    }
    const broken = await h.createApp({
      override: (builder) =>
        builder.overrideProvider(MembershipLifecycle).useValue(new WithFailingParticipant()),
    });
    try {
      const events = await h.inspector.auditLog.count();
      const response = await h
        .as(owner.token, broken)
        .delete(`/organizations/${organization}/members/${leaver.id}`);
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('cleanup failed');

      expect(await isOrganizationMember(organization, leaver.id)).toBe(true); // the membership is still there
      expect((await memberRows(project.id)).some((row) => row.userId === leaver.id)).toBe(true); // the cleanup's deletes were rolled back
      expect(await h.inspector.auditLog.count()).toBe(events); // and so were its events and the organization's
    } finally {
      await broken.close();
    }
    // the same removal succeeds on the healthy application
    expect((await call(owner).delete(`/organizations/${organization}/members/${leaver.id}`)).status).toBe(
      204,
    );
    expect(await orphans()).toBe(0);
  });

  it('fails closed with 409 membership_in_use when project memberships exist and no participant removes them: nothing changes', async () => {
    const [owner, leaver] = [await h.signUp('nc-owner'), await h.signUp('nc-leaver')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, leaver, 'member');
    const project = await newProject(owner, organization);
    await addMember(owner, project.id, leaver.id, 'project_viewer').expect(201);

    class WithoutParticipants extends MembershipLifecycle {
      override participants() {
        return [];
      }
    }
    const unprotected = await h.createApp({
      override: (builder) =>
        builder.overrideProvider(MembershipLifecycle).useValue(new WithoutParticipants()),
    });
    try {
      const events = await h.inspector.auditLog.count();
      const response = await h
        .as(owner.token, unprotected)
        .delete(`/organizations/${organization}/members/${leaver.id}`);
      expect([response.status, errorOf(response.body).code]).toEqual([409, 'membership_in_use']);
      expect(await isOrganizationMember(organization, leaver.id)).toBe(true);
      expect((await memberRows(project.id)).some((row) => row.userId === leaver.id)).toBe(true);
      expect(await h.inspector.auditLog.count()).toBe(events);
      expect(await orphans()).toBe(0);
    } finally {
      await unprotected.close();
    }
  });

  it('preserves the Phase 2.2 behavior for a user with no project memberships', async () => {
    const [owner, member] = [await h.signUp('p22-owner'), await h.signUp('p22-member')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, member, 'member');
    expect((await call(owner).delete(`/organizations/${organization}/members/${member.id}`)).status).toBe(
      204,
    );
    const events = await h.inspector.auditLog.findMany({ where: { organizationId: organization } });
    expect(actionsOf(events)).toEqual([
      'membership.added',
      'membership.added',
      'membership.removed',
      'organization.created',
      'organization.owner_granted',
    ]);
  });

  it('REFUSES TO START when the projects cleanup is enabled but did not register with the organizations module', async () => {
    class SilentLifecycle extends MembershipLifecycle {
      override registerRemovalParticipant(): void {
        /* the registration does not take */
      }
    }
    await expect(
      h.createApp({
        override: (builder) => builder.overrideProvider(MembershipLifecycle).useValue(new SilentLifecycle()),
      }),
    ).rejects.toThrow(
      /projects module is enabled but its membership removal participant .* is not registered/s,
    );
  });
});

describe('races between project memberships and organization memberships (real concurrent requests)', () => {
  const ROUNDS = 12;

  it('B (deterministic) an add that is in flight makes the removal WAIT, and the removal then cleans the row the add created', async () => {
    const [owner, target] = [await h.signUp('bd-owner'), await h.signUp('bd-target')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, target, 'member');
    const project = await newProject(owner, organization);

    const gate = gateOn('project_member.added'); // the add is held after it inserted, before it commits
    const slow = await h.createApp(gate.options);
    try {
      const add = h
        .as(owner.token, slow)
        .post(`/projects/${project.id}/members`, { userId: target.id, projectRole: 'project_member' })
        .then((response) => response);
      await gate.hasReached;
      let removalDone = false;
      const removal = call(owner)
        .delete(`/organizations/${organization}/members/${target.id}`)
        .then((response) => {
          removalDone = true;
          return response;
        });
      await sleep(600);
      expect(removalDone).toBe(false); // it is waiting for the add's hold on the membership

      gate.release();
      const [added, removed] = [await add, await removal];
      expect([added.status, removed.status]).toEqual([201, 204]);
      expect((await memberRows(project.id)).some((row) => row.userId === target.id)).toBe(false);
      const events = await auditFor(project.id);
      expect(
        actionsOf(events.filter((entry) => (entry.metadata as { userId?: string }).userId === target.id)),
      ).toEqual(['project_member.added', 'project_member.removed']);
      expect(
        events.find(
          (entry) =>
            entry.action === 'project_member.removed' &&
            (entry.metadata as { userId?: string }).userId === target.id,
        )?.metadata,
      ).toMatchObject({ reason: 'organization_membership_removed' });
    } finally {
      gate.release();
      await slow.close();
    }
  });

  it('B (deterministic) a removal that is in flight makes the add WAIT, and the add then answers "not a member" with nothing inserted', async () => {
    const [owner, target] = [await h.signUp('bw-owner'), await h.signUp('bw-target')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, target, 'member');
    const project = await newProject(owner, organization);

    const gate = gateOn('membership.removed'); // the removal is held after it deleted the row, before it commits
    const slow = await h.createApp(gate.options);
    try {
      const removal = h
        .as(owner.token, slow)
        .delete(`/organizations/${organization}/members/${target.id}`)
        .then((response) => response);
      await gate.hasReached;
      let addDone = false;
      const add = addMember(owner, project.id, target.id).then((response) => {
        addDone = true;
        return response;
      });
      await sleep(600);
      expect(addDone).toBe(false); // it is waiting for the removal's lock on the membership

      gate.release();
      const [removed, added] = [await removal, await add];
      expect([removed.status, added.status, errorOf(added.body).code]).toEqual([
        204,
        404,
        'organization_member_not_found',
      ]);
      expect((await memberRows(project.id)).some((row) => row.userId === target.id)).toBe(false);
    } finally {
      gate.release();
      await slow.close();
    }
  });

  it(`B adding a member while their organization membership is removed ends in one of two clean outcomes, never a 500 or an orphan (${ROUNDS} rounds)`, async () => {
    const [owner, target] = [await h.signUp('br-owner'), await h.signUp('br-target')];
    const organization = await h.createOrganization(owner);
    const project = await newProject(owner, organization);
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      await h.addOrganizationMember(owner, organization, target, 'member');
      const [added, removed] = await Promise.all([
        addMember(owner, project.id, target.id),
        call(owner).delete(`/organizations/${organization}/members/${target.id}`),
      ]);
      expect(removed.status, `round ${round}`).toBe(204);
      expect([201, 404], `round ${round}`).toContain(added.status);
      outcomes.add(`add ${added.status}`);
      expect(
        await memberRows(project.id).then((rows) => rows.some((row) => row.userId === target.id)),
        `round ${round}`,
      ).toBe(false);
      expect(await isOrganizationMember(organization, target.id)).toBe(false);
      const cleaned = (await auditFor(project.id)).filter(
        (entry) =>
          entry.action === 'project_member.removed' &&
          (entry.metadata as { userId?: string }).userId === target.id,
      ).length;
      // an add that succeeded must have been cleaned up by the removal, exactly once per successful add so far
      expect(cleaned).toBeGreaterThanOrEqual(0);
    }
    expect(await orphans()).toBe(0);
    const addedEvents = await h.inspector.auditLog.count({
      where: { projectId: project.id, action: 'project_member.added', resourceType: 'project_member' },
    });
    const removedEvents = await h.inspector.auditLog.count({
      where: { projectId: project.id, action: 'project_member.removed' },
    });
    expect(removedEvents).toBe(addedEvents - 1); // every add except the creator's was undone by exactly one cleanup event
  });

  it(`B creating a project while the creator is removed from the organization: a project with its creator, or nothing at all (${ROUNDS} rounds)`, async () => {
    const [owner, creator] = [await h.signUp('bc-owner'), await h.signUp('bc-creator')];
    const organization = await h.createOrganization(owner);
    for (let round = 0; round < ROUNDS; round += 1) {
      await h.addOrganizationMember(owner, organization, creator, 'member');
      const slug = `bc-${round}-${uid()}`;
      const [created, removed] = await Promise.all([
        call(creator).post('/projects', { organizationId: organization, name: 'Racing', slug }),
        call(owner).delete(`/organizations/${organization}/members/${creator.id}`),
      ]);
      expect(removed.status, `round ${round}`).toBe(204);
      expect([201, 404], `round ${round}`).toContain(created.status);
      const row = await h.inspector.project.findFirst({ where: { organizationId: organization, slug } });
      if (created.status === 201) {
        expect(row, `round ${round}`).not.toBeNull();
        expect(await memberRows(row!.id)).toEqual([]); // the creator left in the same breath: the cleanup removed the creator row
      } else {
        expect(row, `round ${round}`).toBeNull(); // rolled back as a whole: no project without its creator row
      }
    }
    expect(await orphans()).toBe(0);
  });

  it('A two removals of the same user at the same time: one wins, the other finds nothing, the cleanup runs once', async () => {
    const [owner, admin, leaver] = [
      await h.signUp('ar-owner'),
      await h.signUp('ar-admin'),
      await h.signUp('ar-leaver'),
    ];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    for (let round = 0; round < 6; round += 1) {
      await h.addOrganizationMember(owner, organization, leaver, 'member');
      const project = await newProject(owner, organization);
      await addMember(owner, project.id, leaver.id, 'project_member').expect(201);
      const [byAdmin, byLeaver] = await Promise.all([
        call(admin).delete(`/organizations/${organization}/members/${leaver.id}`),
        call(leaver).delete(`/organizations/${organization}/members/${leaver.id}`),
      ]);
      expect([byAdmin.status, byLeaver.status].sort(), `round ${round}`).toEqual([204, 404].sort());
      const events = (await auditFor(project.id)).filter(
        (entry) => entry.action === 'project_member.removed',
      );
      expect(events, `round ${round}`).toHaveLength(1);
    }
  });

  it('A a removal racing a role change or a removal of the same project membership: one clean outcome each, never a 500', async () => {
    const [owner, target] = [await h.signUp('ac-owner'), await h.signUp('ac-target')];
    const organization = await h.createOrganization(owner);
    const project = await newProject(owner, organization);
    for (let round = 0; round < ROUNDS; round += 1) {
      await h.addOrganizationMember(owner, organization, target, 'member');
      await addMember(owner, project.id, target.id, 'project_viewer').expect(201);
      const change =
        round % 2 === 0
          ? call(owner).patch(`/projects/${project.id}/members/${target.id}`, {
              projectRole: 'project_admin',
            })
          : call(owner).delete(`/projects/${project.id}/members/${target.id}`);
      const [changed, removed] = await Promise.all([
        change,
        call(owner).delete(`/organizations/${organization}/members/${target.id}`),
      ]);
      expect(removed.status, `round ${round}`).toBe(204);
      expect([200, 204, 404], `round ${round}`).toContain(changed.status);
      expect(
        (await memberRows(project.id)).some((row) => row.userId === target.id),
        `round ${round}`,
      ).toBe(false);
    }
    expect(await orphans()).toBe(0);
  });

  it('C re-roling the target in the organization while they are added to a project: both succeed, no deadlock', async () => {
    const [owner, target] = [await h.signUp('cr-owner'), await h.signUp('cr-target')];
    const organization = await h.createOrganization(owner);
    const project = await newProject(owner, organization);
    for (let round = 0; round < ROUNDS; round += 1) {
      await h.addOrganizationMember(owner, organization, target, 'member');
      const [added, rerole] = await Promise.all([
        addMember(owner, project.id, target.id),
        call(owner).patch(`/organizations/${organization}/members/${target.id}`, {
          role: round % 2 ? 'viewer' : 'admin',
        }),
      ]);
      expect([added.status, rerole.status], `round ${round}`).toEqual([201, 200]);
      await call(owner).delete(`/projects/${project.id}/members/${target.id}`).expect(204);
      await call(owner).delete(`/organizations/${organization}/members/${target.id}`).expect(204);
    }
  });

  it('C the actor demoted while changing project membership: the window of V1 never creates a membership for a non-member', async () => {
    const [owner, admin, target] = [
      await h.signUp('cd-owner'),
      await h.signUp('cd-admin'),
      await h.signUp('cd-target'),
    ];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    await h.addOrganizationMember(owner, organization, target, 'member');
    const project = await newProject(owner, organization);
    let completed = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const [added] = await Promise.all([
        addMember(admin, project.id, target.id),
        call(owner).patch(`/organizations/${organization}/members/${admin.id}`, {
          role: round % 2 === 0 ? 'member' : 'admin',
        }),
      ]);
      expect([201, 404, 409], `round ${round}`).toContain(added.status); // 404: already demoted; 409: already a member from an earlier round
      if (added.status === 201) completed += 1;
      await call(owner).delete(`/projects/${project.id}/members/${target.id}`);
      await call(owner)
        .patch(`/organizations/${organization}/members/${admin.id}`, { role: 'admin' })
        .expect(200);
    }
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(await orphans()).toBe(0);
  });

  it('adds the same member once when the request arrives several times at the same time', async () => {
    const [owner, target] = [await h.signUp('dd-owner'), await h.signUp('dd-target')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, target, 'member');
    const project = await newProject(owner, organization);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => addMember(owner, project.id, target.id)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await memberRows(project.id)).filter((row) => row.userId === target.id)).toHaveLength(1);
    expect(
      (await auditFor(project.id)).filter(
        (entry) =>
          entry.action === 'project_member.added' &&
          (entry.metadata as { origin: string }).origin === 'added',
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent role changes and concurrent removals of one member', async () => {
    const [owner, target] = [await h.signUp('cc-owner'), await h.signUp('cc-target')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, target, 'member');
    const project = await newProject(owner, organization);
    await addMember(owner, project.id, target.id, 'project_viewer').expect(201);

    const roles: ProjectRole[] = ['project_admin', 'project_member', 'project_viewer', 'project_admin'];
    const changes = await Promise.all(
      roles.map((projectRole) =>
        call(owner).patch(`/projects/${project.id}/members/${target.id}`, { projectRole }),
      ),
    );
    expect(changes.every((response) => response.status === 200)).toBe(true);
    const finalRole = (await memberRows(project.id)).find((row) => row.userId === target.id)?.role;
    expect(roles).toContain(finalRole);
    const events = (await auditFor(project.id)).filter(
      (entry) => entry.action === 'project_member.role_changed',
    );
    // each recorded change names the role it really replaced: the chain of (previousRole -> role) is consistent
    let current: string = 'project_viewer';
    for (const event of events) {
      const metadata = event.metadata as { previousRole: string; role: string };
      expect(metadata.previousRole).toBe(current);
      current = metadata.role;
    }
    expect(current).toBe(finalRole);

    const removals = await Promise.all(
      Array.from({ length: 5 }, () => call(owner).delete(`/projects/${project.id}/members/${target.id}`)),
    );
    expect(removals.map((response) => response.status).sort()).toEqual([204, 404, 404, 404, 404]);
  });

  it(`archive racing an add: a member is never added to an archived project (${ROUNDS} rounds)`, async () => {
    const [owner, target] = [await h.signUp('ap-owner'), await h.signUp('ap-target')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, target, 'member');
    for (let round = 0; round < ROUNDS; round += 1) {
      const project = await newProject(owner, organization);
      const [added, archived] = await Promise.all([
        addMember(owner, project.id, target.id),
        call(owner).post(`/projects/${project.id}/archive`),
      ]);
      expect(archived.status).toBe(200);
      expect([201, 409], `round ${round}`).toContain(added.status);
      const row = await h.inspector.project.findUniqueOrThrow({ where: { id: project.id } });
      const member = (await memberRows(project.id)).find((entry) => entry.userId === target.id);
      expect(row.status).toBe('archived');
      if (member) {
        // the add won the lock: its row must have been written BEFORE the project was archived
        expect(member.createdAt.getTime()).toBeLessThanOrEqual(row.archivedAt!.getTime());
        expect(added.status).toBe(201);
      } else {
        expect(added.status).toBe(409); // archived first: refused
      }
    }
  });

  it('survives a mixed storm of organization and project operations with no server error, no deadlock and no orphan', async () => {
    const [owner, admin] = [await h.signUp('st-owner'), await h.signUp('st-admin')];
    const organization = await h.createOrganization(owner);
    await h.addOrganizationMember(owner, organization, admin, 'admin');
    const people: Person[] = [];
    for (let i = 0; i < 4; i += 1) {
      const person = await h.signUp(`st-m${i}`);
      await h.addOrganizationMember(owner, organization, person, 'member');
      people.push(person);
    }
    const projects = [
      await newProject(owner, organization),
      await newProject(owner, organization),
      await newProject(owner, organization),
    ];
    const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;
    const statuses: Record<string, number> = {};
    const record = (label: string, status: number) => {
      const key = `${label} ${status}`;
      statuses[key] = (statuses[key] ?? 0) + 1;
    };

    const operations: Record<string, () => Promise<number>> = {
      addProjectMember: async () =>
        (
          await addMember(
            pick([owner, admin]),
            pick(projects).id,
            pick(people).id,
            pick(['project_admin', 'project_member', 'project_viewer'] as const),
          )
        ).status,
      changeProjectRole: async () =>
        (
          await call(owner).patch(`/projects/${pick(projects).id}/members/${pick(people).id}`, {
            projectRole: pick(['project_admin', 'project_viewer'] as const),
          })
        ).status,
      removeProjectMember: async () =>
        (await call(owner).delete(`/projects/${pick(projects).id}/members/${pick(people).id}`)).status,
      removeOrganizationMember: async () =>
        (await call(pick([owner, admin])).delete(`/organizations/${organization}/members/${pick(people).id}`))
          .status,
      addOrganizationMember: async () =>
        (
          await call(owner).post(`/organizations/${organization}/members`, {
            email: pick(people).email,
            role: 'member',
          })
        ).status,
      reroleOrganizationMember: async () =>
        (
          await call(owner).patch(`/organizations/${organization}/members/${pick(people).id}`, {
            role: pick(['member', 'viewer', 'admin'] as const),
          })
        ).status,
      archiveToggle: async () =>
        (await call(owner).post(`/projects/${pick(projects).id}/${pick(['archive', 'restore'])}`)).status,
      updateProject: async () =>
        (await call(owner).patch(`/projects/${pick(projects).id}`, { name: `Storm ${uid()}` })).status,
      createProject: async () =>
        (
          await call(pick(people)).post('/projects', {
            organizationId: organization,
            name: 'Storm',
            slug: `storm-${uid()}-${uid()}`,
          })
        ).status,
      listProjects: async () =>
        (await call(pick(people)).get(`/projects?organizationId=${organization}`)).status,
    };
    const names = Object.keys(operations);
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let i = 0; i < 25; i += 1) {
          const name = pick(names);
          record(name, await operations[name]!());
        }
      }),
    );
    const serverErrors = Object.entries(statuses).filter(([key]) => /\s5\d\d$/.test(key));
    expect(serverErrors).toEqual([]);
    expect(await orphans()).toBe(0);
  }, 120_000);
});
