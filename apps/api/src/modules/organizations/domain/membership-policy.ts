import {
  PERMISSION_KEYS,
  PERMISSIONS,
  type OrganizationRole,
  type PermissionKey,
  type ProjectPermissionKey,
  type ProjectRole,
  projectRoleHasPermission,
  roleHasPermission,
} from '@agentos/contracts';

/*
 * The organizations domain rules, as pure functions (ADR-0010, decision 5). `AuthorizationService` only executes the code-owned matrix;
 * HOW a membership may change is decided here, in the domain that owns it.
 */

/**
 * The UNION rule (ADR-0011, decision 4): what an organization role grants (organization keys, plus project keys it holds implicitly on
 * every project) together with what a project role grants ON ONE PROJECT. The project role comes only from the row of the project the
 * caller is acting on, so the result is only valid for that project. A project role contributes project-scoped keys alone (the catalog's
 * types forbid anything else), so this never adds an organization permission.
 */
export function permissionsFor(
  role: OrganizationRole,
  projectRole: ProjectRole | null = null,
): ReadonlySet<PermissionKey> {
  const granted = new Set<PermissionKey>();
  for (const key of PERMISSION_KEYS) {
    if (roleHasPermission(role, key)) granted.add(key);
    else if (
      projectRole !== null &&
      PERMISSIONS[key].scope === 'project' &&
      projectRoleHasPermission(projectRole, key as ProjectPermissionKey)
    )
      granted.add(key);
  }
  return granted;
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
