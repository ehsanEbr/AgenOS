import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  PROJECT_ROLES,
  type OrganizationRole,
  type PermissionKey,
  type ProjectRole,
} from '@agentos/contracts';
import { permissionsFor } from './membership-policy';

/*
 * The union rule of ADR-0011 decision 4, checked against tables written out here independently of the code under test.
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
const ALL_PROJECT_KEYS: PermissionKey[] = [
  'project.read',
  'project.update',
  'project.archive',
  'project.member.manage',
];
/** What an organization role holds on EVERY project with no project membership. */
const IMPLICIT: Record<OrganizationRole, PermissionKey[]> = {
  owner: ALL_PROJECT_KEYS,
  admin: ALL_PROJECT_KEYS,
  member: [],
  viewer: [],
};
/** What a project role holds on ITS project. */
const EXPLICIT: Record<ProjectRole, PermissionKey[]> = {
  project_admin: ALL_PROJECT_KEYS,
  project_member: ['project.read'],
  project_viewer: ['project.read'],
};

const expected = (role: OrganizationRole, projectRole: ProjectRole | null): PermissionKey[] =>
  [...ORGANIZATION_KEYS[role], ...IMPLICIT[role], ...(projectRole ? EXPLICIT[projectRole] : [])].sort();

describe('permissionsFor: the union of the organization role and the project role', () => {
  it('equals the expected table for every organization role and every project role (and none)', () => {
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of [null, ...PROJECT_ROLES])
        expect([...new Set(permissionsFor(role, projectRole))].sort(), `${role} + ${projectRole}`).toEqual(
          [...new Set(expected(role, projectRole))].sort(),
        );
  });

  it('gives owner and admin access to every project with no project role, and member and viewer none', () => {
    for (const role of ['owner', 'admin'] as const)
      expect(permissionsFor(role, null).has('project.read')).toBe(true);
    for (const role of ['member', 'viewer'] as const)
      expect(permissionsFor(role, null).has('project.read')).toBe(false);
  });

  it('(P1) never changes an organization-level decision: the same keys with and without any project role', () => {
    const organizationKeys = PERMISSION_KEYS.filter((key) => PERMISSIONS[key].scope === 'organization');
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of PROJECT_ROLES)
        for (const key of organizationKeys)
          expect(permissionsFor(role, projectRole).has(key), `${role} + ${projectRole} / ${key}`).toBe(
            permissionsFor(role, null).has(key),
          );
  });

  it('(P3) adds only project-scoped keys: whatever a project role contributes is never an organization permission', () => {
    for (const role of ORGANIZATION_ROLES)
      for (const projectRole of PROJECT_ROLES) {
        const withRole = permissionsFor(role, projectRole);
        const without = permissionsFor(role, null);
        for (const key of withRole)
          if (!without.has(key)) expect(PERMISSIONS[key].scope, key).toBe('project');
      }
  });

  it('lets an organization viewer with project_admin administer the project and nothing else (the approved union)', () => {
    const granted = permissionsFor('viewer', 'project_admin');
    for (const key of ALL_PROJECT_KEYS) expect(granted.has(key), key).toBe(true);
    for (const key of [
      'project.create',
      'organization.update',
      'member.manage',
      'member.manage_owners',
    ] as const)
      expect(granted.has(key), key).toBe(false);
  });

  it('(P2) is a function of ONE project role: a role for another project is a different call, with its own result', () => {
    // The role of project P is passed in for P; for another project Q the caller has no role (null) and gets only the organization role's.
    const onP = permissionsFor('member', 'project_admin');
    const onQ = permissionsFor('member', null);
    expect(onP.has('project.update')).toBe(true);
    expect(onQ.has('project.update')).toBe(false);
    expect(onQ.has('project.read')).toBe(false);
  });
});
