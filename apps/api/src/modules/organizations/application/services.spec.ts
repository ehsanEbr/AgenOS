import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION_ERROR_CODES, type OrganizationRole } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import { FakeAudit, FakeTransactions } from '../../../../test/support/identity-fakes';
import {
  FakeUserDirectory,
  InMemoryMemberships,
  InMemoryOrganizations,
} from '../../../../test/support/organization-fakes';
import type { AuditRecorder } from '../../audit';
import type { TransactionRunner } from '../../database';
import type { UserDirectory } from '../../identity';
import { type TenantContext } from '../domain/tenant';
import { AuthorizationService } from './authorization.service';
import { MembershipService } from './membership.service';
import { OrganizationService } from './organization.service';
import { TenantAccess } from './tenant-access';

function build() {
  const memberships = new InMemoryMemberships();
  const organizations = new InMemoryOrganizations(memberships);
  memberships.organizations = organizations;
  const users = new FakeUserDirectory();
  const audit = new FakeAudit();
  const transactions = new FakeTransactions() as unknown as TransactionRunner;
  const tenants = new TenantAccess(memberships);
  const authorization = new AuthorizationService();
  const auditRecorder = audit as unknown as AuditRecorder;
  return {
    memberships,
    organizations,
    users,
    audit,
    tenants,
    organizationService: new OrganizationService(
      organizations,
      memberships,
      tenants,
      authorization,
      transactions,
      auditRecorder,
    ),
    membershipService: new MembershipService(
      memberships,
      users as unknown as UserDirectory,
      tenants,
      authorization,
      transactions,
      auditRecorder,
    ),
  };
}

/** An organization with one user per requested role (the first listed owner created it), as the tenant context each would have. */
async function organizationWith(roles: OrganizationRole[]) {
  const world = build();
  const founder = world.users.add('founder');
  const { organization } = await world.organizationService.create({ userId: founder.id }, 'Acme');
  const actors: Record<string, TenantContext> = {
    founder: { organizationId: organization.id, userId: founder.id, role: 'owner' },
  };
  const ids: Record<string, string> = { founder: founder.id };
  for (const [index, role] of roles.entries()) {
    const name = `${role}${index}`;
    const user = world.users.add(name);
    world.memberships.insert(organization.id, { userId: user.id, role });
    actors[name] = { organizationId: organization.id, userId: user.id, role };
    ids[name] = user.id;
  }
  world.audit.events.length = 0; // the setup is not under test
  return { ...world, organization, actors, ids };
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

describe('creating an organization', () => {
  it('makes the creator its owner and records the three events, once each', async () => {
    const world = build();
    const user = world.users.add('ada');
    const created = await world.organizationService.create({ userId: user.id }, 'Analytical Engines');

    expect(created.role).toBe('owner');
    expect(world.memberships.rolesIn(created.organization.id)).toEqual({ [user.id]: 'owner' });
    expect(world.audit.actions()).toEqual([
      'organization.created',
      'membership.added',
      'organization.owner_granted',
    ]);
    expect(world.audit.events.every((event) => event.actorUserId === user.id)).toBe(true);
    expect(world.audit.events.every((event) => event.organizationId === created.organization.id)).toBe(true);
  });

  it('gives two organizations with the same name different ids and no shared members', async () => {
    const world = build();
    const [a, b] = [world.users.add('a'), world.users.add('b')];
    const first = await world.organizationService.create({ userId: a.id }, 'Same');
    const second = await world.organizationService.create({ userId: b.id }, 'Same');
    expect(first.organization.id).not.toBe(second.organization.id);
    expect(world.memberships.rolesIn(first.organization.id)).toEqual({ [a.id]: 'owner' });
  });
});

describe('tenant resolution', () => {
  it('accepts a member and answers a malformed id, an unknown id and a non-member identically', async () => {
    const { tenants, organization, ids } = await organizationWith(['member']);
    await expect(tenants.resolve({ userId: ids.member0! }, organization.id)).resolves.toMatchObject({
      role: 'member',
    });

    const outsider = randomUUID();
    for (const id of [organization.id, randomUUID(), 'not-a-uuid', '']) {
      const error = await tenants.resolve({ userId: outsider }, id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ kind: 'not_found', code: ORGANIZATION_ERROR_CODES.organizationNotFound });
    }
  });
});

describe('renaming', () => {
  it('lets owners and admins rename, refuses members and viewers, and audits only a real change', async () => {
    const world = await organizationWith(['admin', 'member', 'viewer']);
    const { organizationService: service, actors, audit } = world;

    await expect(service.rename(actors.admin0!, 'Renamed')).resolves.toMatchObject({
      organization: { name: 'Renamed' },
    });
    expect(audit.events).toMatchObject([
      { action: 'organization.updated', metadata: { changedFields: ['name'] } },
    ]);

    audit.events.length = 0;
    await service.rename(actors.founder!, 'Renamed'); // same name: nothing to record
    expect(audit.events).toEqual([]);

    expect(await code(service.rename(actors.member1!, 'x'))).toBe('forbidden');
    expect(await code(service.rename(actors.viewer2!, 'x'))).toBe('forbidden');
  });

  it('applies a demotion that happened after the request was authorized (the role is re-read)', async () => {
    const world = await organizationWith(['admin']);
    const stale = world.actors.admin0!; // resolved as admin
    await world.membershipService.changeRole(world.actors.founder!, stale.userId, 'viewer');
    expect(await code(world.organizationService.rename(stale, 'Too late'))).toBe('forbidden');
  });
});

describe('adding a member', () => {
  it('adds an existing active user, matching the email as given, and records membership.added', async () => {
    const world = await organizationWith(['admin']);
    const grace = world.users.add('grace');
    const added = await world.membershipService.add(world.actors.admin0!, {
      email: 'grace@example.com',
      role: 'member',
    });
    expect(added.membership.role).toBe('member');
    expect(added.user.id).toBe(grace.id);
    expect(world.audit.events).toMatchObject([
      {
        action: 'membership.added',
        metadata: { userId: grace.id, role: 'member' },
        actorUserId: world.ids.admin0,
      },
    ]);
  });

  it('answers 404 for an unknown or disabled account, 409 for a member, and takes the owners lock first', async () => {
    const world = await organizationWith(['member']);
    world.users.add('gone', 'disabled');
    const owner = world.actors.founder!;
    expect(
      await code(world.membershipService.add(owner, { email: 'nobody@example.com', role: 'member' })),
    ).toBe('user_not_found');
    expect(
      await code(world.membershipService.add(owner, { email: 'gone@example.com', role: 'member' })),
    ).toBe('user_not_found');
    expect(
      await code(world.membershipService.add(owner, { email: 'member0@example.com', role: 'viewer' })),
    ).toBe('already_member');
    expect(world.memberships.lockCalls).toBeGreaterThanOrEqual(3);
    expect(world.audit.events).toEqual([]);
  });

  it('lets only an owner add an owner, and records the ownership grant in addition', async () => {
    const world = await organizationWith(['admin']);
    world.users.add('heir');
    expect(
      await code(
        world.membershipService.add(world.actors.admin0!, { email: 'heir@example.com', role: 'owner' }),
      ),
    ).toBe('forbidden');
    expect(world.audit.events).toEqual([]);

    await world.membershipService.add(world.actors.founder!, { email: 'heir@example.com', role: 'owner' });
    expect(world.audit.actions()).toEqual(['membership.added', 'organization.owner_granted']);
  });

  it('refuses members and viewers before looking anything up', async () => {
    const world = await organizationWith(['member', 'viewer']);
    world.users.add('x');
    for (const actor of [world.actors.member0!, world.actors.viewer1!])
      expect(await code(world.membershipService.add(actor, { email: 'x@example.com', role: 'member' }))).toBe(
        'forbidden',
      );
  });
});

describe('changing a role', () => {
  it('lets an admin manage non-owners but never touch an owner or create one', async () => {
    const world = await organizationWith(['admin', 'member', 'viewer']);
    const admin = world.actors.admin0!;
    await expect(
      world.membershipService.changeRole(admin, world.ids.member1!, 'viewer'),
    ).resolves.toBeTruthy();
    await expect(
      world.membershipService.changeRole(admin, world.ids.viewer2!, 'admin'),
    ).resolves.toBeTruthy();

    expect(await code(world.membershipService.changeRole(admin, world.ids.member1!, 'owner'))).toBe(
      'forbidden',
    ); // create an owner
    expect(await code(world.membershipService.changeRole(admin, world.ids.founder!, 'member'))).toBe(
      'forbidden',
    ); // demote an owner
    expect(await code(world.membershipService.changeRole(admin, world.ids.admin0!, 'owner'))).toBe(
      'forbidden',
    ); // promote oneself
    expect(world.memberships.rolesIn(world.organization.id)[world.ids.founder!]).toBe('owner');
  });

  it('refuses members and viewers', async () => {
    const world = await organizationWith(['member', 'viewer']);
    expect(
      await code(world.membershipService.changeRole(world.actors.member0!, world.ids.viewer1!, 'admin')),
    ).toBe('forbidden');
    expect(
      await code(world.membershipService.changeRole(world.actors.viewer1!, world.ids.viewer1!, 'admin')),
    ).toBe('forbidden');
  });

  it('records role_changed with both roles, and ownership grants and revocations in addition', async () => {
    const world = await organizationWith(['member']);
    const founder = world.actors.founder!;
    const member = world.ids.member0!;

    await world.membershipService.changeRole(founder, member, 'owner');
    expect(world.audit.actions()).toEqual(['membership.role_changed', 'organization.owner_granted']);
    expect(world.audit.events[0]).toMatchObject({
      metadata: { userId: member, previousRole: 'member', role: 'owner' },
    });

    world.audit.events.length = 0;
    await world.membershipService.changeRole(founder, member, 'viewer');
    expect(world.audit.actions()).toEqual(['membership.role_changed', 'organization.owner_revoked']);
    expect(world.audit.events[0]).toMatchObject({
      metadata: { userId: member, previousRole: 'owner', role: 'viewer' },
    });

    world.audit.events.length = 0;
    await world.membershipService.changeRole(founder, member, 'viewer'); // already a viewer
    expect(world.audit.events).toEqual([]);
  });

  it('protects the last owner, including from themselves, and allows the demotion once another owner exists', async () => {
    const world = await organizationWith(['admin']);
    const founder = world.actors.founder!;
    expect(await code(world.membershipService.changeRole(founder, world.ids.founder!, 'admin'))).toBe(
      'last_owner',
    );
    expect(world.memberships.rolesIn(world.organization.id)[world.ids.founder!]).toBe('owner');
    expect(world.audit.events).toEqual([]);

    await world.membershipService.changeRole(founder, world.ids.admin0!, 'owner');
    await expect(
      world.membershipService.changeRole(founder, world.ids.founder!, 'admin'),
    ).resolves.toBeTruthy();
    expect(Object.values(world.memberships.rolesIn(world.organization.id))).toContain('owner');
  });

  it('answers 404 for someone who is not a member', async () => {
    const world = await organizationWith([]);
    expect(
      await code(world.membershipService.changeRole(world.actors.founder!, randomUUID(), 'member')),
    ).toBe('member_not_found');
  });
});

describe('removing a member', () => {
  it('lets an admin remove non-owners only, and an owner remove anyone but the last owner', async () => {
    const world = await organizationWith(['admin', 'member', 'owner']);
    const admin = world.actors.admin0!;
    expect(await code(world.membershipService.remove(admin, world.ids.owner2!))).toBe('forbidden');
    await world.membershipService.remove(admin, world.ids.member1!);
    expect(world.audit.events).toMatchObject([
      { action: 'membership.removed', metadata: { role: 'member', self: false } },
    ]);

    world.audit.events.length = 0;
    await world.membershipService.remove(world.actors.founder!, world.ids.owner2!);
    expect(world.audit.actions()).toEqual(['membership.removed', 'organization.owner_revoked']);
    expect(await code(world.membershipService.remove(world.actors.founder!, world.ids.founder!))).toBe(
      'last_owner',
    );
  });

  it('refuses members and viewers removing somebody else, but lets anyone leave (unless they are the last owner)', async () => {
    const world = await organizationWith(['member', 'viewer', 'viewer']);
    expect(await code(world.membershipService.remove(world.actors.member0!, world.ids.viewer1!))).toBe(
      'forbidden',
    );
    expect(await code(world.membershipService.remove(world.actors.viewer1!, world.ids.member0!))).toBe(
      'forbidden',
    );

    world.audit.events.length = 0;
    await world.membershipService.remove(world.actors.viewer1!, world.ids.viewer1!);
    expect(world.audit.events).toMatchObject([
      { action: 'membership.removed', metadata: { self: true, role: 'viewer' } },
    ]);
    await world.membershipService.remove(world.actors.member0!, world.ids.member0!);
    expect(world.memberships.rolesIn(world.organization.id)).toEqual({
      [world.ids.founder!]: 'owner',
      [world.ids.viewer2!]: 'viewer',
    });
    expect(await code(world.membershipService.remove(world.actors.founder!, world.ids.founder!))).toBe(
      'last_owner',
    );
  });

  it('lets an owner leave when another owner remains, and records the revocation', async () => {
    const world = await organizationWith(['owner']);
    await world.membershipService.remove(world.actors.founder!, world.ids.founder!);
    expect(world.audit.actions()).toEqual(['membership.removed', 'organization.owner_revoked']);
    expect(world.audit.events[0]).toMatchObject({ metadata: { self: true, role: 'owner' } });
  });

  it('answers 404 for a target that is not a member', async () => {
    const world = await organizationWith([]);
    expect(await code(world.membershipService.remove(world.actors.founder!, randomUUID()))).toBe(
      'member_not_found',
    );
  });

  it('refuses a caller who was removed after their request was authorized', async () => {
    const world = await organizationWith(['admin', 'member']);
    const stale = world.actors.admin0!;
    await world.membershipService.remove(world.actors.founder!, stale.userId);
    expect(await code(world.membershipService.remove(stale, world.ids.member1!))).toBe(
      'organization_not_found',
    );
  });
});

describe('every membership change takes the owners lock first', () => {
  it('locks for add, change and remove alike', async () => {
    const world = await organizationWith(['member']);
    world.users.add('zed');
    const founder = world.actors.founder!;
    const before = world.memberships.lockCalls;
    await world.membershipService.add(founder, { email: 'zed@example.com', role: 'viewer' });
    await world.membershipService.changeRole(founder, world.ids.member0!, 'admin');
    await world.membershipService.remove(founder, world.ids.member0!);
    expect(world.memberships.lockCalls - before).toBe(3);
  });
});

describe('listing', () => {
  it('lists the caller organizations with their own role, and the members with their identity', async () => {
    const world = await organizationWith(['viewer']);
    const mine = await world.organizationService.listOf(
      { userId: world.ids.viewer0! },
      { limit: 20, offset: 0 },
    );
    expect(mine.items.map((item) => [item.organization.id, item.role])).toEqual([
      [world.organization.id, 'viewer'],
    ]);

    const members = await world.membershipService.list(world.actors.viewer0!, { limit: 20, offset: 0 });
    expect(members.total).toBe(2);
    expect(members.items.map((item) => item.user.email).sort()).toEqual([
      'founder@example.com',
      'viewer0@example.com',
    ]);
  });
});
