import { z } from 'zod';

/*
 * The permission catalog and the role matrix (ADR-0010, decision 5). Both are CODE: roles are enum values stored on a membership, and
 * what each role may do is the constant below. There is no permission table, so nothing can edit the matrix at runtime; changing it is a
 * code review and a deployment. The API is authoritative; the web may read this only to hide controls.
 *
 * A domain adds its permission keys here as part of "contracts first". Project permissions (ADR-0011) are tagged `project`.
 */

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

/** The roles a user can hold on ONE project. They never carry organization-level permissions (see `PermissionDefinition`). */
export const PROJECT_ROLES = ['project_admin', 'project_member', 'project_viewer'] as const;
export const projectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/** `organization` permissions apply to the organization itself; `project` permissions apply to one project. */
export type PermissionScope = 'organization' | 'project';

interface OrganizationPermissionDefinition {
  readonly scope: 'organization';
  readonly description: string;
  /** The organization roles that hold this permission. */
  readonly roles: readonly OrganizationRole[];
}

interface ProjectPermissionDefinition {
  readonly scope: 'project';
  readonly description: string;
  /** The organization roles that hold this permission IMPLICITLY, on every project of the organization, with no project membership. */
  readonly roles: readonly OrganizationRole[];
  /** The project roles that hold this permission on THAT project only. */
  readonly projectRoles: readonly ProjectRole[];
}

/**
 * A union on purpose (ADR-0010 decision 5, ADR-0011 decision 4): only a `project` key may list `projectRoles`, so a project role can
 * never be given an organization-level permission: doing so does not compile.
 */
export type PermissionDefinition = OrganizationPermissionDefinition | ProjectPermissionDefinition;

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
  'project.list': {
    scope: 'organization',
    description:
      'Ask for the projects of an organization. The answer contains only the projects the caller can access.',
    roles: everyone,
  },
  'project.create': {
    scope: 'organization',
    description: 'Create a project in the organization.',
    roles: ['owner', 'admin', 'member'],
  },
  'project.read': {
    scope: 'project',
    description: 'See a project and its members. Holding it is what having access to the project means.',
    roles: administrators,
    projectRoles: ['project_admin', 'project_member', 'project_viewer'],
  },
  'project.update': {
    scope: 'project',
    description: 'Change the name and description of a project.',
    roles: administrators,
    projectRoles: ['project_admin'],
  },
  'project.archive': {
    scope: 'project',
    description: 'Archive and restore a project.',
    roles: administrators,
    projectRoles: ['project_admin'],
  },
  'project.member.manage': {
    scope: 'project',
    description: 'Add project members, change their project role and remove them.',
    roles: administrators,
    projectRoles: ['project_admin'],
  },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** Keys whose scope is one project. Only these can be held through a project role. */
export type ProjectPermissionKey = {
  [K in PermissionKey]: (typeof PERMISSIONS)[K]['scope'] extends 'project' ? K : never;
}[PermissionKey];
export const PROJECT_PERMISSION_KEYS = PERMISSION_KEYS.filter(
  (key): key is ProjectPermissionKey => PERMISSIONS[key].scope === 'project',
);

/**
 * Does an organization role hold the permission? For a `project` key this means IMPLICIT access on every project of the organization
 * (owner, admin); access through a project role is `projectRoleHasPermission`.
 */
export function roleHasPermission(role: OrganizationRole, permission: PermissionKey): boolean {
  return (PERMISSIONS[permission].roles as readonly OrganizationRole[]).includes(role);
}

/** Does a project role hold the permission ON ITS PROJECT? Only project-scoped keys can be asked: the type forbids the rest. */
export function projectRoleHasPermission(role: ProjectRole, permission: ProjectPermissionKey): boolean {
  return (PERMISSIONS[permission].projectRoles as readonly ProjectRole[]).includes(role);
}
