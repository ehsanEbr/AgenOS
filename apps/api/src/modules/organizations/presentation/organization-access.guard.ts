import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@agentos/contracts';
import { AuthorizationService } from '../application/authorization.service';
import { TenantAccess } from '../application/tenant-access';
import { REQUIRED_PERMISSION_KEY } from './decorators';
import type { HttpRequest } from './http';

/**
 * Tenant resolution and authorization for every route under `/organizations/:organizationId` (ADR-0010, decisions 4 and 5).
 *
 * Order: the global AuthenticationGuard has already run (no session = 401). Then the organization named in the path is accepted only if
 * the caller is a member (otherwise 404, the same as a nonexistent or malformed id), and only then is the permission checked (a member
 * without it gets 403). The resulting `TenantContext` is what the handler receives; it never sees the raw id as authority.
 *
 * Fail closed: a route that uses this guard without declaring a permission is a programming error and is refused with a 500, never
 * served unchecked.
 */
@Injectable()
export class OrganizationAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantAccess,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const permission = this.reflector.getAllAndOverride<PermissionKey | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission)
      throw new Error('A route under OrganizationAccessGuard does not declare @RequirePermission');

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const principal = request.auth?.principal;
    if (!principal) throw new Error('OrganizationAccessGuard ran before authentication');

    const tenant = await this.tenants.resolve(principal, request.params['organizationId'] ?? '');
    this.authorization.authorize(tenant, permission);
    request.tenant = tenant;
    return true;
  }
}
