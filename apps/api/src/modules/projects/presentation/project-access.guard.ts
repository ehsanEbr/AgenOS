import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/app-error';
import { ProjectAccess } from '../application/project-access';
import { PROJECT_ACCESS_KEY, type ProjectRouteAccess } from './decorators';
import type { HttpRequest } from './http';

/**
 * Tenant resolution and authorization for every `/projects` route (ADR-0011, decision 5). The global AuthenticationGuard has already
 * run (no session = 401). Then, depending on the route:
 *   project-addressed        the project is found among the caller's organizations in one query; anything the caller cannot see is the
 *                            same `404 project_not_found`; a project they can see but not do this to is `403`
 *   organization-addressed   the `organizationId` selector must be one of the caller's organizations (`404 organization_not_found`)
 *                            and they must hold the permission (`403`); an absent selector is a `400`
 *
 * Fail closed: a route under this guard that declares nothing is a programming error and is refused with a 500, never served unchecked.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const route = this.reflector.getAllAndOverride<ProjectRouteAccess | undefined>(PROJECT_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!route) throw new Error('A route under ProjectAccessGuard does not declare its access');

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const principal = request.auth?.principal;
    if (!principal) throw new Error('ProjectAccessGuard ran before authentication');

    if (route.kind === 'project') {
      request.projectContext = await this.access.resolveProject(
        principal,
        request.params['projectId'] ?? '',
        route.permission,
      );
      return true;
    }

    const selector =
      route.from === 'query'
        ? request.query?.['organizationId']
        : (request.body as { organizationId?: unknown } | undefined)?.organizationId;
    if (typeof selector !== 'string' || selector === '')
      throw new AppError('validation', 'validation_error', 'Request validation failed', {
        details: [{ path: 'organizationId', message: 'Required' }],
      });
    request.organizationContext = await this.access.resolveOrganization(
      principal,
      selector,
      route.permission,
    );
    return true;
  }
}
