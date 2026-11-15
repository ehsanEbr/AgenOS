import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@agentos/contracts';
import type { OrganizationContext, ProjectContext } from '../domain/project-context';
import type { HttpRequest } from './http';

export const PROJECT_ACCESS_KEY = 'agentos:project-access';

/**
 * How a route reaches its tenant, and the permission it needs (ADR-0011, decision 5):
 *   project       `/projects/:projectId/...`: the project is found among the caller's organizations
 *   organization  the organization is a SELECTOR in the query or the body (list, create), validated against the caller's memberships
 * `ProjectAccessGuard` reads it; a route under that guard that declares nothing is refused, not served.
 */
export type ProjectRouteAccess =
  | { readonly kind: 'project'; readonly permission: PermissionKey }
  | { readonly kind: 'organization'; readonly permission: PermissionKey; readonly from: 'query' | 'body' };

/** Declares the permission a project-addressed route needs. */
export const RequireProjectPermission = (permission: PermissionKey) =>
  SetMetadata(PROJECT_ACCESS_KEY, { kind: 'project', permission } satisfies ProjectRouteAccess);

/** Declares the permission an organization-addressed route needs, and where its `organizationId` selector is. */
export const RequireOrganizationPermission = (permission: PermissionKey, from: 'query' | 'body') =>
  SetMetadata(PROJECT_ACCESS_KEY, { kind: 'organization', permission, from } satisfies ProjectRouteAccess);

/** The project the caller is acting on, validated by the guard. */
export const CurrentProject = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ProjectContext => {
    const project = context.switchToHttp().getRequest<HttpRequest>().projectContext;
    if (!project) throw new Error('CurrentProject used on a route that is not project-addressed');
    return project;
  },
);

/** The organization the caller is acting in, validated by the guard. */
export const CurrentOrganization = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrganizationContext => {
    const organization = context.switchToHttp().getRequest<HttpRequest>().organizationContext;
    if (!organization)
      throw new Error('CurrentOrganization used on a route that is not organization-addressed');
    return organization;
  },
);
