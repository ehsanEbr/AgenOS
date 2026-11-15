import { type PermissionKey, type ProjectRole, idSchema } from '@agentos/contracts';
import { type OrganizationScope, type TenantContext, scopeOf } from '../../organizations';
import type { ProjectRecord } from './project';

/*
 * What a request is allowed to act on, and the scopes repositories demand (ADR-0011, decision 5).
 *
 * NOTHING here is built from a raw id sent by the client. A context exists only after `ProjectAccess` has read the caller's
 * memberships and the project from PostgreSQL; the scope is derived from the context, never from request parameters. The instances are
 * classes with private constructors, and the places that may build or derive them are pinned by `scope-construction.e2e.spec.ts`:
 * `ProjectAccess` creates the contexts (the one call site in this module), and this file derives the scopes.
 */

/** The organization the caller is acting in (list, create): the tenant plus the scope organization-level queries need. */
export class OrganizationContext {
  private constructor(
    readonly tenant: TenantContext,
    readonly scope: OrganizationScope,
  ) {}

  /** Only `ProjectAccess` calls this (architecture test). */
  static create(tenant: TenantContext): OrganizationContext {
    return new OrganizationContext(tenant, scopeOf(tenant));
  }
}

/** The proof a project repository demands: this project, in this organization. Obtained only from a `ProjectContext`. */
export class ProjectScope {
  private constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}

  static of(organizationId: string, projectId: string): ProjectScope {
    return new ProjectScope(organizationId, projectId);
  }
}

/**
 * The caller acting on ONE project: the tenant, the project as read from the database, their explicit role on it and the permissions
 * the union rule gives them ON THIS PROJECT. It is not reusable for another project: acting on another one needs another
 * `ProjectAccess.resolve`, which reads that project's role.
 */
export class ProjectContext {
  private constructor(
    readonly tenant: TenantContext,
    readonly project: ProjectRecord,
    readonly projectRole: ProjectRole | null,
    readonly permissions: ReadonlySet<PermissionKey>,
  ) {}

  /** Only `ProjectAccess` calls this (architecture test). */
  static create(
    tenant: TenantContext,
    project: ProjectRecord,
    projectRole: ProjectRole | null,
    permissions: ReadonlySet<PermissionKey>,
  ): ProjectContext {
    if (tenant.organizationId !== project.organizationId)
      throw new Error('A ProjectContext was built for a tenant that is not the organization of the project');
    return new ProjectContext(tenant, project, projectRole, permissions);
  }

  /** The scope for this project and its organization, derived here and nowhere else. */
  get scope(): ProjectScope {
    return projectScopeOf(this);
  }
}

/** Derives the scope of a genuine `ProjectContext`; anything else (a look-alike, `undefined`) is refused. */
export function projectScopeOf(context: ProjectContext): ProjectScope {
  if (!(context instanceof ProjectContext))
    throw new Error('A project scope can only be derived from a ProjectContext');
  return requireProjectScope(ProjectScope.of(context.project.organizationId, context.project.id));
}

/** Throws a plain Error (an unexpected 500, never a client-facing answer) unless `scope` is a genuine scope with valid ids. */
export function requireProjectScope(scope: unknown): ProjectScope {
  if (
    !(scope instanceof ProjectScope) ||
    !idSchema.safeParse(scope.organizationId).success ||
    !idSchema.safeParse(scope.projectId).success
  )
    throw new Error('A project repository was called without a valid ProjectScope');
  return scope;
}
