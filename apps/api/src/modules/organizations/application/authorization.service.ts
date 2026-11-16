import { Injectable } from '@nestjs/common';
import { type PermissionKey, type ProjectRole, roleHasPermission } from '@agentos/contracts';
import { permissionsFor } from '../domain/membership-policy';
import type { TenantContext } from '../domain/tenant';
import { forbidden } from './errors';

/**
 * A policy execution boundary, not a business-logic service (ADR-0010, decision 5): it asks the code-owned matrix whether the role of a
 * `TenantContext` holds a permission and either returns or throws 403. It knows nothing about HOW a domain object may change (the
 * last-owner rule, "a project member must belong to the organization"); those stay in the domain that owns them.
 *
 * Being a member of the organization is established before this is called (`TenantAccess`: a non-member is a 404, never a 403).
 */
@Injectable()
export class AuthorizationService {
  can(tenant: TenantContext, permission: PermissionKey): boolean {
    return roleHasPermission(tenant.role, permission);
  }

  authorize(tenant: TenantContext, ...permissions: PermissionKey[]): void {
    for (const permission of permissions) if (!this.can(tenant, permission)) throw forbidden();
  }

  /**
   * Everything the caller may do on ONE project: the union of their organization role and their explicit role on that project
   * (`null` when they have none). Valid only for the project whose role was passed in. Whether the caller has access at all is
   * `has('project.read')`; the caller of this method decides 404 versus 403 (ADR-0011, decision 5).
   */
  permissionsOn(tenant: TenantContext, projectRole: ProjectRole | null): ReadonlySet<PermissionKey> {
    return permissionsFor(tenant.role, projectRole);
  }

  authorizeOnProject(
    tenant: TenantContext,
    projectRole: ProjectRole | null,
    ...permissions: PermissionKey[]
  ): void {
    const granted = this.permissionsOn(tenant, projectRole);
    for (const permission of permissions) if (!granted.has(permission)) throw forbidden();
  }
}
