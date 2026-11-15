import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
  type OrganizationRole,
  type PermissionKey,
  roleHasPermission,
} from './index';

/** The ADR-0010 matrix, written out independently of the code that implements it. */
const EXPECTED: Record<PermissionKey, readonly OrganizationRole[]> = {
  'organization.read': ['owner', 'admin', 'member', 'viewer'],
  'organization.update': ['owner', 'admin'],
  'member.read': ['owner', 'admin', 'member', 'viewer'],
  'member.manage': ['owner', 'admin'],
  'member.manage_owners': ['owner'],
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
});
