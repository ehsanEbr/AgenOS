import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  type OrganizationRole,
  PERMISSION_KEYS,
  roleHasPermission,
} from '@agentos/contracts';
import { leavesNoOwner, permissionsFor, permissionsToChangeMembership } from './membership-policy';
import { OrganizationScope, requireScope, scopeOf } from './tenant';

describe('OrganizationScope (fail closed)', () => {
  const tenant = { organizationId: randomUUID(), userId: randomUUID(), role: 'member' as const };

  it('is produced from a TenantContext and carries its organization', () => {
    expect(requireScope(scopeOf(tenant)).organizationId).toBe(tenant.organizationId);
  });

  it('refuses anything that is not a genuine scope with a valid id', () => {
    const forged: unknown[] = [
      undefined,
      null,
      '',
      tenant.organizationId, // a bare id is a selector, not a scope
      { organizationId: tenant.organizationId }, // a look-alike object
      Object.create(OrganizationScope.prototype), // right prototype, no id
      OrganizationScope.of(''),
      OrganizationScope.of('not-a-uuid'),
      OrganizationScope.of(undefined as unknown as string),
    ];
    for (const value of forged) expect(() => requireScope(value)).toThrow(/OrganizationScope/);
  });

  it('refuses to build a scope from a context with a malformed or missing id', () => {
    expect(() => scopeOf({ ...tenant, organizationId: 'x' })).toThrow();
    expect(() => scopeOf(undefined as never)).toThrow();
  });
});

describe('permissionsFor', () => {
  it('is exactly the matrix for every role', () => {
    for (const role of ORGANIZATION_ROLES) {
      const granted = permissionsFor(role);
      for (const permission of PERMISSION_KEYS)
        expect(granted.has(permission), `${role} / ${permission}`).toBe(roleHasPermission(role, permission));
    }
  });
});

describe('permissionsToChangeMembership', () => {
  const roles: (OrganizationRole | null)[] = [null, ...ORGANIZATION_ROLES];

  it('needs ownership permission exactly when an owner is involved, before or after', () => {
    for (const current of roles)
      for (const next of roles) {
        const needed = permissionsToChangeMembership(current, next);
        const involvesOwner = current === 'owner' || next === 'owner';
        expect(needed, `${current} -> ${next}`).toContain('member.manage');
        expect(needed.includes('member.manage_owners'), `${current} -> ${next}`).toBe(involvesOwner);
      }
  });

  it('leaves an admin able to manage every non-owner and no owner, and an owner able to manage everyone', () => {
    const can = (role: OrganizationRole, current: OrganizationRole | null, next: OrganizationRole | null) =>
      permissionsToChangeMembership(current, next).every((permission) => roleHasPermission(role, permission));
    for (const current of roles)
      for (const next of roles) {
        const involvesOwner = current === 'owner' || next === 'owner';
        expect(can('admin', current, next), `admin ${current} -> ${next}`).toBe(!involvesOwner);
        expect(can('owner', current, next), `owner ${current} -> ${next}`).toBe(true);
        expect(can('member', current, next)).toBe(false);
        expect(can('viewer', current, next)).toBe(false);
      }
  });
});

describe('leavesNoOwner', () => {
  const [a, b] = [randomUUID(), randomUUID()];
  it('is true only when the leaving user is the only owner', () => {
    expect(leavesNoOwner([a], a)).toBe(true);
    expect(leavesNoOwner([a, b], a)).toBe(false);
    expect(leavesNoOwner([a, b], b)).toBe(false);
  });
  it('treats an organization with no owner at all as a violation (it must never happen)', () => {
    expect(leavesNoOwner([], a)).toBe(true);
  });
});
