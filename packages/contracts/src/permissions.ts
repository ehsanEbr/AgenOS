import { z } from 'zod';

/*
 * The permission catalog and the role matrix (ADR-0010, decision 5). Both are CODE: roles are enum values stored on a membership, and
 * what each role may do is the constant below. There is no permission table, so nothing can edit the matrix at runtime; changing it is a
 * code review and a deployment. The API is authoritative; the web may read this only to hide controls.
 *
 * A domain adds its permission keys here as part of "contracts first" (project permissions arrive with the projects step).
 */

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

/** `organization` permissions apply to the organization itself; `project` permissions (a later step) apply to one project. */
export type PermissionScope = 'organization' | 'project';

interface PermissionDefinition {
  readonly scope: PermissionScope;
  readonly description: string;
  /** The organization roles that hold this permission. */
  readonly roles: readonly OrganizationRole[];
}

const everyone = ORGANIZATION_ROLES;
const administrators = ['owner', 'admin'] as const;

export const PERMISSIONS = {
  'organization.read': {
    scope: 'organization',
    description: 'See the organization.',
    roles: everyone,
  },
  'organization.update': {
    scope: 'organization',
    description: 'Change the organization (its name).',
    roles: administrators,
  },
  'member.read': {
    scope: 'organization',
    description: 'See the members of the organization and their roles.',
    roles: everyone,
  },
  'member.manage': {
    scope: 'organization',
    description: 'Add members, change the roles of non-owners and remove non-owners.',
    roles: administrators,
  },
  'member.manage_owners': {
    scope: 'organization',
    description:
      'Grant or revoke ownership: add an owner, change an owner role, remove an owner. Only owners hold it.',
    roles: ['owner'],
  },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function roleHasPermission(role: OrganizationRole, permission: PermissionKey): boolean {
  return (PERMISSIONS[permission].roles as readonly OrganizationRole[]).includes(role);
}
