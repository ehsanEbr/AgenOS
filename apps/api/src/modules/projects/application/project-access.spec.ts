import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PROJECT_ROLES,
  type OrganizationRole,
  type PermissionKey,
  type ProjectRole,
} from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import { FakeAudit, FakeTransactions } from '../../../../test/support/identity-fakes';
import { InMemoryMemberships } from '../../../../test/support/organization-fakes';
import { InMemoryProjectMembers, InMemoryProjects } from '../../../../test/support/project-fakes';
import type { AuditRecorder } from '../../audit';
import type { TransactionRunner } from '../../database';
import { AuthorizationService, MembershipDirectory, TenantAccess } from '../../organizations';
import { ProjectContext } from '../domain/project-context';
import { projectArchived } from './errors';
import { ProjectAccess } from './project-access';
import { ProjectService } from './project.service';

/** A world: one organization, and a project in it, with one user per organization role and helpers to give them project roles. */
function build() {
  const orgMemberships = new InMemoryMemberships();
  const members = new InMemoryProjectMembers();
  const projects = new InMemoryProjects(members);
  const access = new ProjectAccess(
    new TenantAccess(orgMemberships),
    new AuthorizationService(),
    new MembershipDirectory(orgMemberships),
    projects,
    members,
  );
  const audit = new FakeAudit();
  const service = new ProjectService(
    projects,
    access,
    new AuthorizationService(),
    new FakeTransactions() as unknown as TransactionRunner,
    audit as unknown as AuditRecorder,
  );
  const organization = randomUUID();
  const project = projects.seed(organization, 'apollo');
  const join = (role: OrganizationRole) => {
    const userId = randomUUID();
    orgMemberships.insert(organization, { userId, role });
    return userId;
  };
  return { orgMemberships, members, projects, access, service, audit, organization, project, join };
}

const outcome = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) return `${error.kind}:${error.code}`;
    throw error;
  }
};

/** What the matrix of ADR-0011 decision 4 says each combination may do ON ONE PROJECT, written out independently of the code. */
function expectedOutcome(
  org: OrganizationRole,
  projectRole: ProjectRole | null,
  permission: PermissionKey,
): string {
  const implicit = org === 'owner' || org === 'admin';
  const hasRead = implicit || projectRole !== null; // any project role includes project.read
  if (!hasRead) return 'not_found:project_not_found';
  const projectKeys: Record<string, ProjectRole[]> = {
    'project.read': ['project_admin', 'project_member', 'project_viewer'],
    'project.update': ['project_admin'],
    'project.archive': ['project_admin'],
    'project.member.manage': ['project_admin'],
  };
  const allowed = implicit || (projectRole !== null && (projectKeys[permission] ?? []).includes(projectRole));
  return allowed ? 'ok' : 'forbidden:forbidden';
}

describe('ProjectAccess: who gets to a project, and what happens when they do not', () => {
  const permissions: PermissionKey[] = [
    'project.read',
    'project.update',
    'project.archive',
    'project.member.manage',
  ];

  it('matches the matrix for every organization role x every project role (and none) x every project permission', async () => {
    for (const org of ORGANIZATION_ROLES)
      for (const projectRole of [null, ...PROJECT_ROLES])
        for (const permission of permissions) {
          const world = build();
          const user = world.join(org);
          if (projectRole) world.members.insert(world.project, user, projectRole);
          expect(
            await outcome(world.access.resolveProject({ userId: user }, world.project.id, permission)),
            `${org} + ${projectRole} / ${permission}`,
          ).toBe(expectedOutcome(org, projectRole, permission));
        }
  });

  it('answers the same 404 for a project that does not exist, one of another organization, a malformed id and a non-member', async () => {
    const world = build();
    const stranger = randomUUID();
    const otherOrganization = randomUUID();
    const foreign = world.projects.seed(otherOrganization, 'elsewhere');
    const member = world.join('owner');

    const answers = await Promise.all([
      outcome(world.access.resolveProject({ userId: member }, randomUUID(), 'project.read')), // nonexistent
      outcome(world.access.resolveProject({ userId: member }, foreign.id, 'project.read')), // another organization
      outcome(world.access.resolveProject({ userId: member }, 'not-a-uuid', 'project.read')), // malformed
      outcome(world.access.resolveProject({ userId: stranger }, world.project.id, 'project.read')), // in no organization
    ]);
    expect(new Set(answers)).toEqual(new Set(['not_found:project_not_found']));
  });

  it('gives an organization member with no project role the 404 of a project that does not exist, not a 403', async () => {
    const world = build();
    const member = world.join('member');
    expect(
      await outcome(world.access.resolveProject({ userId: member }, world.project.id, 'project.update')),
    ).toBe('not_found:project_not_found');
  });

  it('(union) lets an organization viewer with project_admin administer THAT project and no other', async () => {
    const world = build();
    const other = world.projects.seed(world.organization, 'other-project');
    const viewer = world.join('viewer');
    world.members.insert(world.project, viewer, 'project_admin');
    for (const permission of [
      'project.read',
      'project.update',
      'project.archive',
      'project.member.manage',
    ] as const)
      expect(
        await outcome(world.access.resolveProject({ userId: viewer }, world.project.id, permission)),
        permission,
      ).toBe('ok');
    // the other project of the same organization does not exist for them
    expect(await outcome(world.access.resolveProject({ userId: viewer }, other.id, 'project.read'))).toBe(
      'not_found:project_not_found',
    );
  });

  it('builds a ProjectContext that carries the union for that project only, and nothing for organization-level permissions', async () => {
    const world = build();
    const viewer = world.join('viewer');
    world.members.insert(world.project, viewer, 'project_admin');
    const context = await world.access.resolveProject({ userId: viewer }, world.project.id, 'project.read');
    expect(context).toBeInstanceOf(ProjectContext);
    expect(context.projectRole).toBe('project_admin');
    expect(context.permissions.has('project.update')).toBe(true);
    expect(context.permissions.has('project.create')).toBe(false);
    expect(context.permissions.has('organization.update')).toBe(false);
    expect(context.scope).toMatchObject({ organizationId: world.organization, projectId: world.project.id });
  });

  it('applies a demotion or removal that happened after the request was authorized, once it re-checks inside the transaction', async () => {
    const world = build();
    const admin = world.join('admin');
    const context = await world.access.resolveProject({ userId: admin }, world.project.id, 'project.update');
    // the admin is demoted to member (no project role): a change that re-checks now no longer sees the project
    const index = world.orgMemberships.rows.findIndex((row) => row.userId === admin);
    world.orgMemberships.rows[index] = { ...world.orgMemberships.rows[index]!, role: 'member' };
    await expect(world.service.update(context, { name: 'Too late' })).rejects.toMatchObject({
      code: 'project_not_found',
    });
    expect(world.projects.rows.get(world.project.id)!.name).not.toBe('Too late');
    // removed from the organization altogether: also "no such project"
    world.orgMemberships.rows.splice(
      world.orgMemberships.rows.findIndex((row) => row.userId === admin),
      1,
    );
    await expect(world.service.archive(context)).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

describe('ProjectService', () => {
  it('lists only what the caller may see, and counts only that', async () => {
    const world = build();
    const second = world.projects.seed(world.organization, 'second');
    world.projects.seed(world.organization, 'third');
    const member = world.join('member');
    const owner = world.join('owner');
    world.members.insert(second, member, 'project_viewer');

    const asMember = await world.service.list(
      await world.access.resolveOrganization({ userId: member }, world.organization, 'project.list'),
      { status: 'active', limit: 20, offset: 0 },
    );
    expect(asMember.items.map((item) => item.project.id)).toEqual([second.id]);
    expect(asMember.total).toBe(1);
    expect(asMember.items[0]?.projectRole).toBe('project_viewer');

    const asOwner = await world.service.list(
      await world.access.resolveOrganization({ userId: owner }, world.organization, 'project.list'),
      { status: 'active', limit: 20, offset: 0 },
    );
    expect(asOwner.total).toBe(3);
    expect(asOwner.items.every((item) => item.projectRole === null)).toBe(true); // implicit access: no explicit role
  });

  it('creates the project and its creator membership with both events, and the creator is a project_admin', async () => {
    const world = build();
    const creator = world.join('member');
    const organization = await world.access.resolveOrganization(
      { userId: creator },
      world.organization,
      'project.create',
    );
    const view = await world.service.create(organization, {
      name: 'New',
      slug: 'new-one',
      description: 'text',
    });

    expect(view.projectRole).toBe('project_admin');
    expect(world.members.roleOf(view.project.id, creator)).toBe('project_admin');
    expect(world.audit.actions()).toEqual(['project.created', 'project_member.added']);
    expect(world.audit.events[1]).toMatchObject({
      resourceType: 'project_member',
      metadata: { userId: creator, role: 'project_admin', origin: 'project_created' },
      projectId: view.project.id,
      organizationId: world.organization,
    });
  });

  it('refuses a duplicate slug in the organization and a viewer creating, and writes nothing', async () => {
    const world = build();
    const creator = world.join('admin');
    const viewer = world.join('viewer');
    const organization = await world.access.resolveOrganization(
      { userId: creator },
      world.organization,
      'project.create',
    );
    expect(await outcome(world.service.create(organization, { name: 'Again', slug: 'apollo' }))).toBe(
      'conflict:project_slug_taken',
    );
    expect(world.audit.events).toEqual([]);
    expect(
      await outcome(
        world.access.resolveOrganization({ userId: viewer }, world.organization, 'project.create'),
      ),
    ).toBe('forbidden:forbidden');
  });

  it('updates name and description, audits field names only, and does nothing (no event) when nothing changes', async () => {
    const world = build();
    const owner = world.join('owner');
    const context = await world.access.resolveProject({ userId: owner }, world.project.id, 'project.update');
    const view = await world.service.update(context, { name: 'Renamed', description: 'about it' });
    expect(view.project).toMatchObject({ name: 'Renamed', description: 'about it' });
    expect(world.audit.events).toMatchObject([
      { action: 'project.updated', metadata: { changedFields: ['name', 'description'] } },
    ]);
    expect(JSON.stringify(world.audit.events)).not.toContain('Renamed');

    world.audit.events.length = 0;
    await world.service.update(
      await world.access.resolveProject({ userId: owner }, world.project.id, 'project.update'),
      { name: 'Renamed' },
    );
    expect(world.audit.events).toEqual([]);
  });

  it('is idempotent: repeating an archive or a restore answers the same project and writes no event', async () => {
    const world = build();
    const owner = world.join('owner');
    const get = (permission: PermissionKey) =>
      world.access.resolveProject({ userId: owner }, world.project.id, permission);

    const first = await world.service.archive(await get('project.archive'));
    expect(first.project.status).toBe('archived');
    const archivedAt = first.project.archivedAt;
    const again = await world.service.archive(await get('project.archive'));
    expect(again.project).toEqual(first.project); // same body, archivedAt unchanged
    expect(again.project.archivedAt).toEqual(archivedAt);
    expect(world.audit.actions()).toEqual(['project.archived']);

    const restored = await world.service.restore(await get('project.archive'));
    expect(restored.project).toMatchObject({ status: 'active', archivedAt: null });
    const restoredAgain = await world.service.restore(await get('project.archive'));
    expect(restoredAgain.project).toEqual(restored.project);
    expect(world.audit.actions()).toEqual(['project.archived', 'project.restored']);
  });

  it('refuses an update of an archived project (409) while still allowing it to be read and restored', async () => {
    const world = build();
    const owner = world.join('owner');
    const get = (permission: PermissionKey) =>
      world.access.resolveProject({ userId: owner }, world.project.id, permission);
    await world.service.archive(await get('project.archive'));

    expect(await outcome(world.service.update(await get('project.update'), { name: 'No' }))).toBe(
      `conflict:${projectArchived().code}`,
    );
    expect((await get('project.read')).project.status).toBe('archived');
    await world.service.restore(await get('project.archive'));
    expect(await outcome(world.service.update(await get('project.update'), { name: 'Yes' }))).toBe('ok');
  });

  it('takes the project lock for every change, including a repeated archive', async () => {
    const world = build();
    const owner = world.join('owner');
    const get = (permission: PermissionKey) =>
      world.access.resolveProject({ userId: owner }, world.project.id, permission);
    await world.service.update(await get('project.update'), { name: 'A' });
    await world.service.archive(await get('project.archive'));
    await world.service.archive(await get('project.archive'));
    await world.service.restore(await get('project.archive'));
    expect(world.projects.lockCalls).toBe(4);
  });
});
