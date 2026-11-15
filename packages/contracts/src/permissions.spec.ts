import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  PROJECT_PERMISSION_KEYS,
  PROJECT_ROLES,
  type OrganizationRole,
  type PermissionDefinition,
  type PermissionKey,
  type ProjectPermissionKey,
  type ProjectRole,
  projectRoleHasPermission,
  roleHasPermission,
} from './index';

/** The ADR-0010 matrix, written out independently of the code that implements it. */
const EXPECTED: Record<PermissionKey, readonly OrganizationRole[]> = {
  'organization.read': ['owner', 'admin', 'member', 'viewer'],
  'organization.update': ['owner', 'admin'],
  'member.read': ['owner', 'admin', 'member', 'viewer'],
  'member.manage': ['owner', 'admin'],
  'member.manage_owners': ['owner'],
  'project.list': ['owner', 'admin', 'member', 'viewer'],
  'project.create': ['owner', 'admin', 'member'],
  // project-scoped keys: the organization roles that hold them IMPLICITLY on every project
  'project.read': ['owner', 'admin'],
  'project.update': ['owner', 'admin'],
  'project.archive': ['owner', 'admin'],
  'project.member.manage': ['owner', 'admin'],
};

/** The project roles that hold each project-scoped key ON THAT PROJECT (ADR-0011 decision 4), written out independently. */
const EXPECTED_PROJECT_ROLES: Record<ProjectPermissionKey, readonly ProjectRole[]> = {
  'project.read': ['project_admin', 'project_member', 'project_viewer'],
  'project.update': ['project_admin'],
  'project.archive': ['project_admin'],
  'project.member.manage': ['project_admin'],
};

describe('the organization role matrix', () => {
  it('matches the ADR-0010 matrix for every role and every permission', () => {
    for (const permission of PERMISSION_KEYS)
      for (const role of ORGANIZATION_ROLES)
        expect(roleHasPermission(role, permission), `${role} / ${permission}`).toBe(
          EXPECTED[permission].includes(role),
        );
  });

  it('lists exactly the permissions of the table (a new key needs a deliberate row here)', () => {
    expect([...PERMISSION_KEYS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('only ever names roles that exist, and every permission is held by at least the owner', () => {
    for (const key of PERMISSION_KEYS) {
      const { roles } = PERMISSIONS[key];
      expect(roles.length).toBeGreaterThan(0);
      expect(roles).toContain('owner');
      for (const role of roles) expect(ORGANIZATION_ROLES).toContain(role);
    }
  });

  it('is monotonic: a more privileged role never holds less than a less privileged one', () => {
    for (const permission of PERMISSION_KEYS)
      for (let index = 1; index < ORGANIZATION_ROLES.length; index += 1) {
        const lesser = ORGANIZATION_ROLES[index]!;
        const greater = ORGANIZATION_ROLES[index - 1]!;
        if (roleHasPermission(lesser, permission)) expect(roleHasPermission(greater, permission)).toBe(true);
      }
  });

  it('keeps ownership changes to owners alone, and an admin cannot do them', () => {
    expect(roleHasPermission('admin', 'member.manage_owners')).toBe(false);
    expect(roleHasPermission('owner', 'member.manage_owners')).toBe(true);
  });

  it('puts project.list and project.create at organization scope: a project role can never grant them', () => {
    expect(PERMISSIONS['project.list'].scope).toBe('organization');
    expect(PERMISSIONS['project.create'].scope).toBe('organization');
    expect(roleHasPermission('viewer', 'project.create')).toBe(false);
  });
});

describe('the project role matrix', () => {
  it('matches the ADR-0011 matrix for every project role and every project-scoped permission', () => {
    for (const permission of PROJECT_PERMISSION_KEYS)
      for (const role of PROJECT_ROLES)
        expect(projectRoleHasPermission(role, permission), `${role} / ${permission}`).toBe(
          EXPECTED_PROJECT_ROLES[permission].includes(role),
        );
  });

  it('lists exactly the project-scoped keys of the matrix', () => {
    expect([...PROJECT_PERMISSION_KEYS].sort()).toEqual(Object.keys(EXPECTED_PROJECT_ROLES).sort());
    for (const key of PERMISSION_KEYS)
      expect(PROJECT_PERMISSION_KEYS.includes(key as ProjectPermissionKey)).toBe(
        PERMISSIONS[key].scope === 'project',
      );
  });

  it('gives only project-scoped keys a list of project roles', () => {
    for (const key of PERMISSION_KEYS)
      expect('projectRoles' in PERMISSIONS[key], key).toBe(PERMISSIONS[key].scope === 'project');
  });

  it('keeps access implied by holding project.read, and administration a superset of reading', () => {
    for (const role of PROJECT_ROLES) {
      if (role === 'project_viewer' || role === 'project_member') {
        expect(projectRoleHasPermission(role, 'project.read')).toBe(true);
        expect(projectRoleHasPermission(role, 'project.update')).toBe(false);
      }
    }
    for (const permission of PROJECT_PERMISSION_KEYS)
      if (projectRoleHasPermission('project_admin', permission) === false)
        throw new Error(`${permission} missing for project_admin`);
  });

  it('does not compile when a project role is given an organization-level permission (the type is the guarantee)', () => {
    const define = (definition: PermissionDefinition) => definition;
    // prettier-ignore
    // @ts-expect-error an organization-scoped key cannot list project roles
    const bad = define({ scope: 'organization', description: 'x', roles: ['owner'], projectRoles: ['project_admin'] });
    expect(bad.scope).toBe('organization');
    // A project-scoped key can; this is the same shape the catalog uses.
    const good = define({
      scope: 'project',
      description: 'x',
      roles: ['owner'],
      projectRoles: ['project_admin'],
    });
    expect(good.scope).toBe('project');
    // Asking whether a project role holds an ORGANIZATION key is rejected by the type (never executed: it would be meaningless).
    const compileOnly = () =>
      // @ts-expect-error organization.update is not a project-scoped permission
      projectRoleHasPermission('project_admin', 'organization.update');
    expect(typeof compileOnly).toBe('function');
  });
});
