import {
  type OrganizationRole,
  type PermissionKey,
  PERMISSIONS,
  roleHasPermission,
} from '@agentos/contracts';

/*
 * The organizations domain rules, as pure functions (ADR-0010, decision 5). `AuthorizationService` only executes the code-owned matrix;
 * HOW a membership may change is decided here, in the domain that owns it.
 */

/** Every permission a role holds. The project-role parameter arrives with the projects step (`permissionsFor(role, projectRole)`). */
export function permissionsFor(role: OrganizationRole): ReadonlySet<PermissionKey> {
  return new Set(
    (Object.keys(PERMISSIONS) as PermissionKey[]).filter((permission) => roleHasPermission(role, permission)),
  );
}

/**
 * What it takes to change one membership: `member.manage` always, and ALSO `member.manage_owners` whenever ownership is involved, that is
 * when the member is an owner now or will be one afterwards. So an admin can manage every non-owner and can neither create, change nor
 * remove an owner, and only an owner can hand ownership out or take it away. `current` is null when the membership does not exist yet
 * (adding), `next` is null when it is being removed.
 */
export function permissionsToChangeMembership(
  current: OrganizationRole | null,
  next: OrganizationRole | null,
): PermissionKey[] {
  return current === 'owner' || next === 'owner'
    ? ['member.manage', 'member.manage_owners']
    : ['member.manage'];
}

/** Leaving the membership of `userId` (removal or demotion) must not leave the organization without an owner. */
export function leavesNoOwner(ownerUserIds: readonly string[], leavingUserId: string): boolean {
  return ownerUserIds.every((ownerId) => ownerId === leavingUserId);
}
