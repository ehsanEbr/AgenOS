import { Inject, Injectable } from '@nestjs/common';
import type { AuditEventInput } from '@agentos/contracts';
import { AuditRecorder } from '../../audit';
import { type DatabaseClient, TransactionRunner } from '../../database';
import { AuthorizationService } from '../../organizations';
import {
  changedProjectFields,
  isArchived,
  type ProjectMemberRecord,
  type ProjectRecord,
  type ProjectView,
} from '../domain/project';
import type { OrganizationContext, ProjectContext } from '../domain/project-context';
import { visibilityFor } from '../domain/visibility';
import { projectArchived } from './errors';
import { ProjectAccess } from './project-access';
import {
  PROJECT_REPOSITORY,
  type PageOf,
  type PageRequest,
  type ProjectRepository,
  type ProjectStatusFilter,
} from './ports';

/** Action, resource type and metadata of an audit event about a project or a project membership (the rest is common to all of them). */
export type ProjectEventBody<E = Extract<AuditEventInput, { resourceType: 'project' | 'project_member' }>> =
  E extends unknown
    ? E extends { action: unknown; resourceType: unknown; metadata: unknown }
      ? { action: E['action']; resourceType: E['resourceType']; metadata: E['metadata'] }
      : never
    : never;

/**
 * Projects: list, create, read, update, archive and restore (ADR-0011).
 *
 * Every CHANGE is one transaction: take the project lock, re-check the caller from the database, apply the change, write its audit
 * events. Anything that fails rolls the change and its events back together. A repeated archive or restore finds the project already in
 * the requested state and changes nothing, writes nothing.
 */
@Injectable()
export class ProjectService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    private readonly access: ProjectAccess,
    private readonly authorization: AuthorizationService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  /** Only the projects the caller can access: visibility is part of the query, before the status filter, the count and the page. */
  list(
    organization: OrganizationContext,
    query: { readonly status: ProjectStatusFilter } & PageRequest,
  ): Promise<PageOf<ProjectView>> {
    const implicitAccess = this.authorization.permissionsOn(organization.tenant, null).has('project.read');
    const visibility = visibilityFor(organization.tenant.userId, implicitAccess);
    return this.projects.list(organization.scope, visibility, query.status, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  get(context: ProjectContext): ProjectView {
    return { project: context.project, projectRole: context.projectRole };
  }

  /**
   * Creates the project and the creator's explicit `project_admin` membership in one transaction, with both events. The creator's
   * organization membership is held for the transaction, so it cannot end under the new rows.
   */
  create(
    organization: OrganizationContext,
    input: { readonly name: string; readonly slug: string; readonly description?: string },
  ): Promise<ProjectView> {
    return this.transactions.run(async (tx) => {
      const fresh = await this.access.beginCreate(organization, tx);
      const { project, member } = await this.projects.createWithCreator(
        fresh.scope,
        { name: input.name, slug: input.slug, description: input.description ?? null },
        fresh.tenant.userId,
        tx,
      );
      const actor = fresh.tenant.userId;
      await this.record(
        actor,
        project,
        project.id,
        { action: 'project.created', resourceType: 'project', metadata: {} },
        tx,
      );
      await this.record(actor, project, member.id, this.addedEvent(member), tx);
      return { project, projectRole: member.role };
    });
  }

  update(
    context: ProjectContext,
    changes: { readonly name?: string; readonly description?: string | null },
  ): Promise<ProjectView> {
    return this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.update', tx);
      if (isArchived(fresh.project)) throw projectArchived();
      const changedFields = changedProjectFields(fresh.project, changes);
      if (changedFields.length === 0) return this.get(fresh); // nothing changes, nothing is recorded
      const project = await this.projects.update(fresh.scope, changes, tx);
      await this.record(
        fresh.tenant.userId,
        project,
        project.id,
        { action: 'project.updated', resourceType: 'project', metadata: { changedFields } },
        tx,
      );
      return { project, projectRole: fresh.projectRole };
    });
  }

  archive(context: ProjectContext): Promise<ProjectView> {
    return this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.archive', tx);
      if (isArchived(fresh.project)) return this.get(fresh); // already archived: same answer, no event
      const project = await this.projects.setArchived(fresh.scope, new Date(), tx);
      await this.record(
        fresh.tenant.userId,
        project,
        project.id,
        { action: 'project.archived', resourceType: 'project', metadata: {} },
        tx,
      );
      return { project, projectRole: fresh.projectRole };
    });
  }

  restore(context: ProjectContext): Promise<ProjectView> {
    return this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.archive', tx);
      if (!isArchived(fresh.project)) return this.get(fresh); // already active: same answer, no event
      const project = await this.projects.setArchived(fresh.scope, null, tx);
      await this.record(
        fresh.tenant.userId,
        project,
        project.id,
        { action: 'project.restored', resourceType: 'project', metadata: {} },
        tx,
      );
      return { project, projectRole: fresh.projectRole };
    });
  }

  private addedEvent(member: ProjectMemberRecord): ProjectEventBody {
    return {
      action: 'project_member.added',
      resourceType: 'project_member',
      metadata: { userId: member.userId, role: member.role, origin: 'project_created' },
    };
  }

  private record(
    actorUserId: string,
    project: ProjectRecord,
    resourceId: string,
    event: ProjectEventBody,
    tx: DatabaseClient,
  ): Promise<void> {
    return this.audit.record(
      {
        ...event,
        result: 'success',
        actorUserId,
        organizationId: project.organizationId,
        projectId: project.id,
        resourceId,
      },
      tx,
    );
  }
}
