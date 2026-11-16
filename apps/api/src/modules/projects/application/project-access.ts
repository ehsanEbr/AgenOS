import { Inject, Injectable } from '@nestjs/common';
import { ORGANIZATION_ERROR_CODES, type PermissionKey, idSchema } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import type { DatabaseClient } from '../../database';
import { AuthorizationService, MembershipDirectory, TenantAccess } from '../../organizations';
import type { ProjectRecord } from '../domain/project';
import { OrganizationContext, ProjectContext } from '../domain/project-context';
import { organizationNotFound, projectNotFound } from './errors';
import {
  PROJECT_MEMBER_REPOSITORY,
  PROJECT_REPOSITORY,
  type ProjectMemberRepository,
  type ProjectRepository,
} from './ports';

/**
 * The ONLY place a trusted context is created (ADR-0011, decision 5; pinned by `scope-construction.e2e.spec.ts`).
 *
 * Each context is the RESULT of reading the caller's memberships and the project from PostgreSQL on this request. A raw id from the
 * client (`organizationId`, `projectId`, a member's `userId`) is only ever a lookup key here; what comes out is a context the
 * repositories can be given.
 *
 * Failure semantics: a project the caller cannot see is `404 project_not_found` whether it does not exist, belongs to another
 * organization, or the caller is a member/viewer without a project membership (visibility follows access). A project the caller can see
 * but may not do this to is `403 forbidden`.
 */
@Injectable()
export class ProjectAccess {
  constructor(
    private readonly tenants: TenantAccess,
    private readonly authorization: AuthorizationService,
    private readonly directory: MembershipDirectory,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(PROJECT_MEMBER_REPOSITORY) private readonly members: ProjectMemberRepository,
  ) {}

  /** Organization-addressed routes (list, create): the id is a selector that must be one of the caller's organizations. */
  async resolveOrganization(
    principal: { readonly userId: string },
    organizationId: string,
    permission: PermissionKey,
  ): Promise<OrganizationContext> {
    const tenant = await this.tenants.resolve(principal, organizationId); // 404 organization_not_found
    this.authorization.authorize(tenant, permission); // 403 forbidden
    return OrganizationContext.create(tenant);
  }

  /**
   * Project-addressed routes. Steps 1 to 7 of ADR-0011 decision 5: validate the id, find the project among the caller's organizations
   * in ONE query, resolve the tenant from the project's organization, read the explicit role, evaluate the union on this project.
   */
  async resolveProject(
    principal: { readonly userId: string },
    projectId: string,
    permission: PermissionKey,
  ): Promise<ProjectContext> {
    if (!idSchema.safeParse(projectId).success) throw projectNotFound();
    const organizationIds = await this.directory.organizationIdsOf(principal.userId);
    if (organizationIds.length === 0) throw projectNotFound();
    const project = await this.projects.findInOrganizations(organizationIds, projectId);
    if (!project) throw projectNotFound();
    return this.contextFor(principal, project, permission);
  }

  /**
   * Starts a CHANGE of a project inside the caller's transaction: takes the project lock (L2), re-reads the project (its status is only
   * trustworthy under the lock) and re-evaluates the caller's access from the database. A demotion or removal that committed a moment
   * earlier applies to this request. A demotion that commits after this point does not: the accepted in-flight window (ADR-0011 Q13, V1).
   */
  async begin(
    context: ProjectContext,
    permission: PermissionKey,
    tx: DatabaseClient,
  ): Promise<ProjectContext> {
    const project = await this.projects.lock(context.scope, tx);
    if (!project) throw projectNotFound();
    return this.contextFor(context.tenant, project, permission, tx);
  }

  /**
   * Starts creating a project inside the caller's transaction: re-resolves and authorizes the creator, then HOLDS their organization
   * membership (L3, shared) before any project row is written, so the membership cannot be removed under the new rows (decision 9).
   */
  async beginCreate(context: OrganizationContext, tx: DatabaseClient): Promise<OrganizationContext> {
    const tenant = await this.tenants.resolve(context.tenant, context.tenant.organizationId, tx);
    this.authorization.authorize(tenant, 'project.create');
    if (!(await this.directory.holdMember(tenant.organizationId, tenant.userId, tx)))
      throw organizationNotFound();
    return OrganizationContext.create(tenant);
  }

  private async contextFor(
    principal: { readonly userId: string },
    project: ProjectRecord,
    permission: PermissionKey,
    db?: DatabaseClient,
  ): Promise<ProjectContext> {
    let tenant;
    try {
      tenant = await this.tenants.resolve(principal, project.organizationId, db);
    } catch (error) {
      // Not a member of the project's organization (any more): for a project that is "no such project", not "no such organization".
      if (error instanceof AppError && error.code === ORGANIZATION_ERROR_CODES.organizationNotFound)
        throw projectNotFound();
      throw error;
    }
    const projectRole = await this.members.findRoleOn(project, principal.userId, db);
    const permissions = this.authorization.permissionsOn(tenant, projectRole);
    if (!permissions.has('project.read')) throw projectNotFound(); // visibility follows access
    this.authorization.authorizeOnProject(tenant, projectRole, permission); // 403 forbidden
    return ProjectContext.create(tenant, project, projectRole, permissions);
  }
}
