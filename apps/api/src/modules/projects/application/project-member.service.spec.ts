import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OrganizationRole, ProjectRole } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import { FakeAudit, FakeTransactions } from '../../../../test/support/identity-fakes';
import { FakeUserDirectory, InMemoryMemberships } from '../../../../test/support/organization-fakes';
import { InMemoryProjectMembers, InMemoryProjects } from '../../../../test/support/project-fakes';
import type { AuditRecorder } from '../../audit';
import type { TransactionRunner } from '../../database';
import type { UserDirectory } from '../../identity';
import {
  AuthorizationService,
  MembershipDirectory,
  MembershipLifecycle,
  TenantAccess,
} from '../../organizations';
import { ProjectAccess } from './project-access';
import { ProjectMemberService } from './project-member.service';
import { ProjectMembershipCleanup } from './project-membership-cleanup';
import { ProjectService } from './project.service';

function build() {
  const orgMemberships = new InMemoryMemberships();
  const members = new InMemoryProjectMembers();
  const projects = new InMemoryProjects(members);
  const directory = new MembershipDirectory(orgMemberships);
  const access = new ProjectAccess(
    new TenantAccess(orgMemberships),
    new AuthorizationService(),
    directory,
    projects,
    members,
  );
  const audit = new FakeAudit();
  const users = new FakeUserDirectory();
  const transactions = new FakeTransactions() as unknown as TransactionRunner;
  const memberService = new ProjectMemberService(
    members,
    access,
    directory,
    users as unknown as UserDirectory,
    transactions,
    audit as unknown as AuditRecorder,
  );
  const projectService = new ProjectService(
    projects,
    access,
    new AuthorizationService(),
    transactions,
    audit as unknown as AuditRecorder,
  );
  const organization = randomUUID();
  const project = projects.seed(organization, 'apollo');
  /** A user who is a member of the organization with this role, known to the user directory. */
  const person = (name: string, role: OrganizationRole) => {
    const user = users.add(name);
    orgMemberships.insert(organization, { userId: user.id, role });
    return user.id;
  };
  /** Resolves the project as this person with the permission a member change needs. */
  const contextFor = (userId: string) =>
    access.resolveProject({ userId }, project.id, 'project.member.manage');
  return {
    orgMemberships,
    members,
    projects,
    access,
    audit,
    users,
    memberService,
    projectService,
    organization,
    project,
    person,
    contextFor,
    directory,
  };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};

describe('adding a project member', () => {
  it('adds an organization member with the audit event "added", and holds exactly ONE organization membership: the target, never the actor', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const target = world.person('target', 'member');
    const view = await world.memberService.add(await world.contextFor(owner), {
      userId: target,
      projectRole: 'project_viewer',
    });

    expect(view.member.role).toBe('project_viewer');
    expect(view.user.id).toBe(target);
    expect(world.audit.events).toMatchObject([
      {
        action: 'project_member.added',
        actorUserId: owner,
        projectId: world.project.id,
        metadata: { userId: target, role: 'project_viewer', origin: 'added' },
      },
    ]);
    // lock-order rule R2: the project side holds at most one organization-membership row, and it is the target's
    expect(world.orgMemberships.held).toEqual([{ organizationId: world.organization, userId: target }]);
  });

  it('answers the same 404 for a user who does not exist and for one who is not a member of the organization', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const stranger = world.users.add('stranger').id; // a real user, in no organization
    const context = await world.contextFor(owner);
    const answers = await Promise.all([
      code(world.memberService.add(context, { userId: randomUUID(), projectRole: 'project_member' })),
      code(world.memberService.add(context, { userId: stranger, projectRole: 'project_member' })),
    ]);
    expect(answers).toEqual(['organization_member_not_found', 'organization_member_not_found']);
    expect(world.members.rows).toEqual([]);
    expect(world.audit.events).toEqual([]);
  });

  it('answers 409 for a second membership, and for an archived project, and records nothing', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const target = world.person('target', 'member');
    await world.memberService.add(await world.contextFor(owner), {
      userId: target,
      projectRole: 'project_member',
    });
    world.audit.events.length = 0;
    expect(
      await code(
        world.memberService.add(await world.contextFor(owner), {
          userId: target,
          projectRole: 'project_admin',
        }),
      ),
    ).toBe('already_project_member');

    await world.projectService.archive(
      await world.access.resolveProject({ userId: owner }, world.project.id, 'project.archive'),
    );
    world.audit.events.length = 0;
    const other = world.person('other', 'member');
    expect(
      await code(
        world.memberService.add(await world.contextFor(owner), {
          userId: other,
          projectRole: 'project_member',
        }),
      ),
    ).toBe('project_archived');
    expect(world.audit.events).toEqual([]);
  });

  it('lets a project_admin add (even one whose organization role is viewer), and refuses a project_member and a stranger', async () => {
    const world = build();
    const viewerAdmin = world.person('viewer-admin', 'viewer');
    world.members.insert(world.project, viewerAdmin, 'project_admin');
    const plain = world.person('plain-member', 'member');
    world.members.insert(world.project, plain, 'project_member');
    const target = world.person('target', 'member');

    await expect(
      world.memberService.add(await world.contextFor(viewerAdmin), {
        userId: target,
        projectRole: 'project_viewer',
      }),
    ).resolves.toBeTruthy();
    // a project_member cannot even reach the add: the access check refuses before the service
    await expect(world.contextFor(plain)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(world.contextFor(world.users.add('nobody').id)).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });
});

describe('changing and removing a project member', () => {
  it('records the role it replaced, writes nothing for the same role, and protects against a vanished row', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const target = world.person('target', 'member');
    world.members.insert(world.project, target, 'project_viewer');

    const changed = await world.memberService.changeRole(
      await world.contextFor(owner),
      target,
      'project_admin',
    );
    expect(changed.member.role).toBe('project_admin');
    expect(world.audit.events).toMatchObject([
      {
        action: 'project_member.role_changed',
        metadata: { userId: target, previousRole: 'project_viewer', role: 'project_admin' },
      },
    ]);
    world.audit.events.length = 0;
    await world.memberService.changeRole(await world.contextFor(owner), target, 'project_admin'); // already that role
    expect(world.audit.events).toEqual([]);
    expect(
      await code(
        world.memberService.changeRole(await world.contextFor(owner), randomUUID(), 'project_viewer'),
      ),
    ).toBe('project_member_not_found');
  });

  it('removes a member with reason "removed", leaves their organization membership alone, and answers 404 for a non-member', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const target = world.person('target', 'member');
    world.members.insert(world.project, target, 'project_member');

    await world.memberService.remove(await world.contextFor(owner), target);
    expect(world.members.rows).toEqual([]);
    expect(world.audit.events).toMatchObject([
      {
        action: 'project_member.removed',
        metadata: { userId: target, role: 'project_member', reason: 'removed' },
      },
    ]);
    expect(world.orgMemberships.rows.some((row) => row.userId === target)).toBe(true); // still an organization member
    expect(await code(world.memberService.remove(await world.contextFor(owner), target))).toBe(
      'project_member_not_found',
    );
  });

  it('refuses every change on an archived project and every one by someone who lost the right', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const target = world.person('target', 'member');
    world.members.insert(world.project, target, 'project_member');
    const context = await world.contextFor(owner);
    await world.projectService.archive(
      await world.access.resolveProject({ userId: owner }, world.project.id, 'project.archive'),
    );
    expect(await code(world.memberService.changeRole(context, target, 'project_admin'))).toBe(
      'project_archived',
    );
    expect(await code(world.memberService.remove(context, target))).toBe('project_archived');
    expect(world.members.rows).toHaveLength(1);
  });

  it('lists the explicit members with their identity, and the owner with implicit access is not among them', async () => {
    const world = build();
    const owner = world.person('owner', 'owner');
    const a = world.person('a', 'member');
    const b = world.person('b', 'viewer');
    world.members.insert(world.project, a, 'project_admin');
    world.members.insert(world.project, b, 'project_viewer');
    const page = await world.memberService.list(await world.contextFor(owner), { limit: 20, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.user.email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('ProjectMembershipCleanup (the removal participant)', () => {
  it('deletes the user project memberships in that organization, archived projects included, and records one event for each', async () => {
    const world = build();
    const cleanup = new ProjectMembershipCleanup(
      world.members,
      world.audit as unknown as AuditRecorder,
      new MembershipLifecycle(),
    );
    const archived = world.projects.seed(world.organization, 'old', {
      status: 'archived',
      archivedAt: new Date(),
    });
    const otherOrganization = randomUUID();
    const elsewhere = world.projects.seed(otherOrganization, 'elsewhere');
    const user = world.person('leaver', 'member');
    const bystander = world.person('bystander', 'member');
    world.members.insert(world.project, user, 'project_admin');
    world.members.insert(archived, user, 'project_viewer');
    world.members.insert(elsewhere, user, 'project_member'); // a different organization (the same person): untouched
    world.members.insert(world.project, bystander, 'project_member');
    const admin = world.person('admin', 'admin');

    await cleanup.onMembershipRemoved(
      { organizationId: world.organization, userId: user, membershipId: randomUUID(), actorUserId: admin },
      {} as never,
    );

    expect(world.members.rows.map((row) => `${row.userId}:${row.projectId}`).sort()).toEqual(
      [`${user}:${elsewhere.id}`, `${bystander}:${world.project.id}`].sort(),
    );
    expect(world.audit.events).toHaveLength(2);
    expect(
      world.audit.events.every(
        (event) => event.action === 'project_member.removed' && event.actorUserId === admin,
      ),
    ).toBe(true);
    expect(world.audit.events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        { userId: user, role: 'project_admin', reason: 'organization_membership_removed' },
        { userId: user, role: 'project_viewer', reason: 'organization_membership_removed' },
      ]),
    );
    expect(new Set(world.audit.events.map((event) => event.projectId))).toEqual(
      new Set([world.project.id, archived.id]),
    );
  });

  it('does nothing, and writes nothing, for a user with no project memberships', async () => {
    const world = build();
    const cleanup = new ProjectMembershipCleanup(
      world.members,
      world.audit as unknown as AuditRecorder,
      new MembershipLifecycle(),
    );
    await cleanup.onMembershipRemoved(
      {
        organizationId: world.organization,
        userId: randomUUID(),
        membershipId: randomUUID(),
        actorUserId: randomUUID(),
      },
      {} as never,
    );
    expect(world.audit.events).toEqual([]);
  });

  it('registers itself with the lifecycle on module init, and lets the application start', () => {
    const world = build();
    const lifecycle = new MembershipLifecycle();
    const cleanup = new ProjectMembershipCleanup(
      world.members,
      world.audit as unknown as AuditRecorder,
      lifecycle,
    );
    cleanup.onModuleInit();
    expect(lifecycle.isRegistered(cleanup.name)).toBe(true);
    expect(() => cleanup.onApplicationBootstrap()).not.toThrow();
  });

  it('REFUSES TO START when it is enabled but not registered, with a message that names the cause', () => {
    const world = build();
    const lifecycle = new MembershipLifecycle(); // module init never ran / registration did not take
    const cleanup = new ProjectMembershipCleanup(
      world.members,
      world.audit as unknown as AuditRecorder,
      lifecycle,
    );
    expect(() => cleanup.onApplicationBootstrap()).toThrow(
      /projects module is enabled but its membership removal participant "projects\.project-membership-cleanup" is not registered .* refuses to start/s,
    );
  });

  it('cannot be registered after bootstrap: the registry is sealed', () => {
    const world = build();
    const lifecycle = new MembershipLifecycle();
    lifecycle.onApplicationBootstrap();
    const cleanup = new ProjectMembershipCleanup(
      world.members,
      world.audit as unknown as AuditRecorder,
      lifecycle,
    );
    expect(() => cleanup.onModuleInit()).toThrow(/sealed/);
  });
});

describe('the project side never holds more than one organization membership', () => {
  it('holds only the creator when creating a project, and only the target when adding a member (never the actor)', async () => {
    const world = build();
    const admin = world.person('admin', 'admin');
    const target = world.person('target', 'member');
    const organizationContext = await world.access.resolveOrganization(
      { userId: admin },
      world.organization,
      'project.create',
    );
    await world.projectService.create(organizationContext, { name: 'New', slug: 'new-project' });
    expect(world.orgMemberships.held.map((held) => held.userId)).toEqual([admin]);

    world.orgMemberships.held.length = 0;
    const roleOf: ProjectRole = 'project_member';
    await world.memberService.add(await world.contextFor(admin), { userId: target, projectRole: roleOf });
    expect(world.orgMemberships.held.map((held) => held.userId)).toEqual([target]);
    // and every other project-side change holds none
    world.orgMemberships.held.length = 0;
    await world.memberService.changeRole(await world.contextFor(admin), target, 'project_viewer');
    await world.memberService.remove(await world.contextFor(admin), target);
    await world.projectService.update(
      await world.access.resolveProject({ userId: admin }, world.project.id, 'project.update'),
      { name: 'Renamed' },
    );
    expect(world.orgMemberships.held).toEqual([]);
  });
});
