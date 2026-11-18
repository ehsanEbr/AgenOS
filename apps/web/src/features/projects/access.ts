import type { ProjectRole } from '@agentos/contracts';
import type { PermissionSubject } from './permissions';
import { useOrganizationRole } from './queries';

/**
 * The subject the permission helper judges (ADR-0012 D3): the caller's organization role, read through this feature's own query, and their
 * explicit role on the project in question (none on the list page). It is `null` until the organization role is known, and when it
 * could not be read: a control is never offered on a guess. The server re-evaluates every request either way.
 */
export function usePermissionSubject(
  organizationId: string,
  projectRole?: ProjectRole | null,
): PermissionSubject | null {
  const organization = useOrganizationRole(organizationId);
  return organization.data ? { organizationRole: organization.data.role, projectRole } : null;
}
