import {
  ORGANIZATION_ROLES,
  PERMISSION_KEYS,
  PROJECT_ROLES,
  type OrganizationRole,
  type PermissionKey,
  type ProjectRole,
  type ProjectStatus,
} from '@agentos/contracts';
import { describe, expect, it } from 'vitest';
import { can, projectActions, type ActionState } from './permissions';

/*
 * The permission helper against an independently written table (ADR-0012 D3). The web cannot import the API and must not import another
 * package's spec files, so the table is written out here with the same content as the two that pin the backend
 * (`contracts/src/permissions.spec.ts` and `organizations/domain/permissions-union.spec.ts`). A deliberate change to the matrix touches
 * all three tests; none of them can pass if it disagrees with the catalog.
 */

const ORGANIZATION_KEYS: Record<OrganizationRole, PermissionKey[]> = {
  owner: [
    'organization.read',
    'member.read',
    'organization.update',
    'member.manage',
    'member.manage_owners',
    'project.list',
    'project.create',
  ],
  admin: [
    'organization.read',
    'member.read',
    'organization.update',
    'member.manage',
    'project.list',
    'project.create',
  ],
  member: ['organization.read', 'member.read', 'project.list', 'project.create'],
  viewer: ['organization.read', 'member.read', 'project.list'],
};

const PROJECT_KEYS: PermissionKey[] = [
  'project.read',
  'project.update',
  'project.archive',
  'project.member.manage',
];

/** What an organization role holds on EVERY project of the organization with no project membership. */
const IMPLICIT: Record<OrganizationRole, PermissionKey[]> = {
  owner: PROJECT_KEYS,
  admin: PROJECT_KEYS,
  member: [],
  viewer: [],
};

/** What a project role holds on ITS project only. */
const EXPLICIT: Record<ProjectRole, PermissionKey[]> = {
  project_admin: PROJECT_KEYS,
  project_member: ['project.read'],
  project_viewer: ['project.read'],
};

const ALL_KEYS_BY_HAND: PermissionKey[] = [
  ...new Set([...Object.values(ORGANIZATION_KEYS).flat(), ...PROJECT_KEYS]),
];

const expected = (role: OrganizationRole, projectRole: ProjectRole | null): PermissionKey[] =>
  [
    ...new Set([
      ...ORGANIZATION_KEYS[role],
      ...IMPLICIT[role],
      ...(projectRole ? EXPLICIT[projectRole] : []),
    ]),
  ].sort();

const held = (role: OrganizationRole, projectRole: ProjectRole | null): PermissionKey[] =>
  PERMISSION_KEYS.filter((key) => can({ organizationRole: role, projectRole }, key)).sort();

const PROJECT_ROLE_CHOICES: (ProjectRole | null)[] = [null, ...PROJECT_ROLES];
const combinations = ORGANIZATION_ROLES.flatMap((role) =>
  PROJECT_ROLE_CHOICES.map((projectRole) => [role, projectRole] as const),
);

describe('the permission catalog the helper is built from', () => {
  it('has exactly the keys of this table: a new key fails here until a row is added on purpose', () => {
    expect([...PERMISSION_KEYS].sort()).toEqual([...ALL_KEYS_BY_HAND].sort());
  });

  it('has the four organization roles and three project roles of this table', () => {
    expect([...ORGANIZATION_ROLES].sort()).toEqual(['admin', 'member', 'owner', 'viewer']);
    expect([...PROJECT_ROLES].sort()).toEqual(['project_admin', 'project_member', 'project_viewer']);
  });
});

describe('can: every organization role x every project role (and none) x every key', () => {
  it.each(combinations)(
    'organization %s with project role %s holds exactly the expected keys',
    (role, projectRole) => {
      expect(held(role, projectRole)).toEqual(expected(role, projectRole));
    },
  );

  it('answers for every combination and every key individually (no key is skipped)', () => {
    let checked = 0;
    for (const [role, projectRole] of combinations) {
      for (const key of PERMISSION_KEYS) {
        const should = expected(role, projectRole).includes(key);
        expect(
          can({ organizationRole: role, projectRole }, key),
          `${role} + ${String(projectRole)} -> ${key}`,
        ).toBe(should);
        checked += 1;
      }
    }
    expect(checked).toBe(ORGANIZATION_ROLES.length * PROJECT_ROLE_CHOICES.length * PERMISSION_KEYS.length);
  });

  it('treats an omitted project role like none', () => {
    for (const role of ORGANIZATION_ROLES)
      for (const key of PERMISSION_KEYS)
        expect(can({ organizationRole: role }, key)).toBe(
          can({ organizationRole: role, projectRole: null }, key),
        );
  });
});

describe('the properties the design relies on', () => {
  const organizationKeys = ALL_KEYS_BY_HAND.filter((key) => !PROJECT_KEYS.includes(key));

  it('P1: a project role never changes an answer for an organization-scoped key', () => {
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of PROJECT_ROLES)
        for (const key of organizationKeys)
          expect(
            can({ organizationRole: role, projectRole }, key),
            `${role} + ${projectRole} -> ${key}`,
          ).toBe(can({ organizationRole: role }, key));
  });

  it('P3: a project role only ever adds project-scoped keys, never takes one away', () => {
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of PROJECT_ROLES) {
        const without = new Set(held(role, null));
        const added = held(role, projectRole).filter((key) => !without.has(key));
        expect(added.every((key) => PROJECT_KEYS.includes(key))).toBe(true);
        for (const key of without) expect(can({ organizationRole: role, projectRole }, key)).toBe(true);
      }
  });

  it('a project role can never grant project.create, project.list, member.manage or organization.update', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const projectRole of PROJECT_ROLES) {
        for (const key of ['project.create', 'project.list', 'member.manage', 'organization.update'] as const)
          expect(can({ organizationRole: role, projectRole }, key)).toBe(
            can({ organizationRole: role }, key),
          );
      }
    }
  });

  it('the union example: an organization viewer who is project_admin administers that project but still cannot create one', () => {
    const subject = { organizationRole: 'viewer', projectRole: 'project_admin' } as const;
    for (const key of PROJECT_KEYS) expect(can(subject, key), key).toBe(true);
    expect(can(subject, 'project.create')).toBe(false);
    expect(can(subject, 'member.manage')).toBe(false);
    expect(can(subject, 'organization.update')).toBe(false);
  });

  it('an organization member without a project role has no access to a project at all', () => {
    for (const key of PROJECT_KEYS) {
      expect(can({ organizationRole: 'member' }, key), key).toBe(false);
      expect(can({ organizationRole: 'viewer' }, key), key).toBe(false);
    }
  });
});

describe('projectActions: the archived rule of the server (409 project_archived) applied to what is shown', () => {
  const holdsWrite = (role: OrganizationRole, projectRole: ProjectRole | null) =>
    role === 'owner' || role === 'admin' || projectRole === 'project_admin';
  const holdsRead = (role: OrganizationRole, projectRole: ProjectRole | null) =>
    holdsWrite(role, projectRole) || projectRole !== null;

  const changeable = (holds: boolean, status: ProjectStatus): ActionState =>
    !holds ? 'hidden' : status === 'archived' ? 'disabled_archived' : 'enabled';

  const statuses: ProjectStatus[] = ['active', 'archived'];

  for (const status of statuses) {
    it.each(combinations)(
      `on an ${status} project, organization %s with project role %s`,
      (role, projectRole) => {
        const actions = projectActions({ organizationRole: role, projectRole }, status);
        const write = holdsWrite(role, projectRole);

        expect(actions.read).toBe(holdsRead(role, projectRole));
        expect(actions.edit).toBe(changeable(write, status)); // shown disabled with the reason when archived
        expect(actions.manageMembers).toBe(changeable(write, status));
        expect(actions.archive).toBe(write && status === 'active' ? 'enabled' : 'hidden'); // offered only while active
        expect(actions.restore).toBe(write && status === 'archived' ? 'enabled' : 'hidden'); // offered to holders, only while archived
        expect(actions.readOnly).toBe(status === 'archived');
      },
    );
  }

  it('an archived project can still be read, and only restoring changes it', () => {
    const actions = projectActions({ organizationRole: 'owner' }, 'archived');
    expect(actions).toEqual({
      read: true,
      edit: 'disabled_archived',
      archive: 'hidden',
      restore: 'enabled',
      manageMembers: 'disabled_archived',
      readOnly: true,
    });
  });

  it('an active project offers archive but not restore', () => {
    const actions = projectActions({ organizationRole: 'admin' }, 'active');
    expect(actions).toEqual({
      read: true,
      edit: 'enabled',
      archive: 'enabled',
      restore: 'hidden',
      manageMembers: 'enabled',
      readOnly: false,
    });
  });

  it('a project_admin through the project role gets the same actions as an owner on that project', () => {
    for (const status of statuses)
      expect(projectActions({ organizationRole: 'viewer', projectRole: 'project_admin' }, status)).toEqual(
        projectActions({ organizationRole: 'owner' }, status),
      );
  });

  it('a project_member sees the project but is offered no change, active or archived', () => {
    for (const status of statuses) {
      const actions = projectActions({ organizationRole: 'member', projectRole: 'project_member' }, status);
      expect(actions.read).toBe(true);
      expect([actions.edit, actions.archive, actions.restore, actions.manageMembers]).toEqual([
        'hidden',
        'hidden',
        'hidden',
        'hidden',
      ]);
    }
  });
});
