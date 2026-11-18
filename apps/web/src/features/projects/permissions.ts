import {
  PERMISSIONS,
  projectRoleHasPermission,
  roleHasPermission,
  type OrganizationRole,
  type PermissionKey,
  type ProjectPermissionKey,
  type ProjectRole,
  type ProjectStatus,
} from '@agentos/contracts';

/*
 * What a person may SEE as a control (ADR-0012 D3). A small pure module over the two primitives the contracts already export; the
 * contracts and the API are unchanged. It chooses what to show and never decides access: the server re-evaluates every request, a
 * project the caller cannot see stays an indistinguishable 404, and a refusal for an action the UI offered means "your access
 * changed" (the page refetches), not an escalation.
 */

/** The two facts the API already returns: the caller's organization role (`GET /organizations/:id`) and their explicit role on a project. */
export interface PermissionSubject {
  organizationRole: OrganizationRole;
  /** The caller's EXPLICIT role on the project (`Project.projectRole`); absent or null when they have none. */
  projectRole?: ProjectRole | null;
}

/**
 * Does the subject hold the permission?
 *  - an organization role holds the key if `roleHasPermission` says so (for a project key this is the implicit access of owners and
 *    admins on every project);
 *  - a project role is consulted ONLY when the key's scope is `project`.
 * So a project role can never add an organization-level permission: `project.create`, `project.list`, `member.manage`,
 * `organization.update` and the rest answer from the organization role alone, whatever project role is passed.
 */
export function can(subject: PermissionSubject, key: PermissionKey): boolean {
  if (roleHasPermission(subject.organizationRole, key)) return true;
  if (PERMISSIONS[key].scope !== 'project' || !subject.projectRole) return false;
  return projectRoleHasPermission(subject.projectRole, key as ProjectPermissionKey);
}

/**
 * How a control is presented on a project page:
 *  - `hidden`: the person does not hold the permission, or the control does not apply in this state;
 *  - `enabled`: offered and usable;
 *  - `disabled_archived`: offered but disabled, with the reason that the project is archived (an archived project is read-only).
 */
export type ActionState = 'hidden' | 'enabled' | 'disabled_archived';

export interface ProjectActions {
  /** May open the project and read its members. */
  read: boolean;
  /** Edit the name and description. Shown disabled on an archived project. */
  edit: ActionState;
  /** Archive. Offered only while the project is active. */
  archive: ActionState;
  /** Restore. Offered to holders of the archive permission, only while the project is archived. */
  restore: ActionState;
  /** Add members, change their role, remove them. Shown disabled on an archived project. */
  manageMembers: ActionState;
  /** The project is archived: nothing about it can be changed except by restoring it. */
  readOnly: boolean;
}

/** The actions of one project page, applying the archived rule that the server enforces (`409 project_archived`). */
export function projectActions(subject: PermissionSubject, status: ProjectStatus): ProjectActions {
  const archived = status === 'archived';
  const changeable = (key: PermissionKey): ActionState =>
    !can(subject, key) ? 'hidden' : archived ? 'disabled_archived' : 'enabled';
  const holdsArchive = can(subject, 'project.archive');
  return {
    read: can(subject, 'project.read'),
    edit: changeable('project.update'),
    archive: holdsArchive && !archived ? 'enabled' : 'hidden',
    restore: holdsArchive && archived ? 'enabled' : 'hidden',
    manageMembers: changeable('project.member.manage'),
    readOnly: archived,
  };
}
