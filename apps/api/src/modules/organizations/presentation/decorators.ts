import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@agentos/contracts';
import type { TenantContext } from '../domain/tenant';
import type { HttpRequest } from './http';

export const REQUIRED_PERMISSION_KEY = 'agentos:required-permission';

/**
 * Declares the permission an organization-scoped route needs. `OrganizationAccessGuard` reads it: it resolves the organization named by
 * `:organizationId` against the caller's membership (404 for a non-member) and checks the permission (403 for a member who lacks it)
 * BEFORE the handler runs. A route under that guard without this decorator is refused, not served.
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

/** The organization the caller is acting in, validated by the guard. Only available on a route that declared `@RequirePermission`. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const tenant = context.switchToHttp().getRequest<HttpRequest>().tenant;
    if (!tenant) throw new Error('CurrentTenant used on a route that did not declare @RequirePermission');
    return tenant;
  },
);
