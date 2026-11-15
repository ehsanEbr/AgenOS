import type { ProjectRole } from '@agentos/contracts';
import type { DatabaseClient } from '../../database';
import type { OrganizationScope } from '../../organizations';
import type { ProjectScope } from '../domain/project-context';
import type { ProjectMemberRecord, ProjectRecord, ProjectView } from '../domain/project';
import type { ProjectVisibility } from '../domain/visibility';

/*
 * Ports of the projects application layer. They live here, not in the domain, because repository methods carry the transaction handle
 * (`DatabaseClient`). Infrastructure implements them.
 *
 * TENANT RULE (ADR-0011, decision 5): every method that reads or writes data of a project takes a `ProjectScope`, and every method that
 * works on the projects of an organization takes an `OrganizationScope`, as its FIRST parameter and refuses to run without a genuine
 * one. The only exceptions are the two clearly named resolution methods, which are how a context is earned in the first place.
 */

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export interface PageOf<T> {
  readonly items: T[];
  readonly total: number;
}

export interface NewProject {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}

export type ProjectStatusFilter = 'active' | 'archived' | 'all';

export interface ProjectRepository {
  /**
   * RESOLUTION (not scoped): the one id-only lookup. Returns the project only if it belongs to one of the given organizations, in a single
   * query; an empty or malformed list returns nothing without touching the database.
   */
  findInOrganizations(
    organizationIds: readonly string[],
    projectId: string,
    db?: DatabaseClient,
  ): Promise<ProjectRecord | null>;

  /**
   * Creates the project AND its creator's `project_admin` membership in one step, so a project never exists without its creator row.
   * Throws `AppError('conflict', 'project_slug_taken')` when the slug is taken in the organization.
   */
  createWithCreator(
    scope: OrganizationScope,
    project: NewProject,
    creatorUserId: string,
    db: DatabaseClient,
  ): Promise<{ project: ProjectRecord; member: ProjectMemberRecord }>;

  /**
   * The projects the caller may SEE, with their explicit role: visibility is part of the query, before the status filter, the count and
   * the page (ADR-0011, "Listing rules").
   */
  list(
    scope: OrganizationScope,
    visibility: ProjectVisibility,
    status: ProjectStatusFilter,
    page: PageRequest,
    db?: DatabaseClient,
  ): Promise<PageOf<ProjectView>>;

  /** `SELECT … FOR UPDATE` on the project (lock level L2), then a fresh read. Null when it does not exist. */
  lock(scope: ProjectScope, db: DatabaseClient): Promise<ProjectRecord | null>;
  update(
    scope: ProjectScope,
    changes: { readonly name?: string; readonly description?: string | null },
    db: DatabaseClient,
  ): Promise<ProjectRecord>;
  setArchived(scope: ProjectScope, archivedAt: Date | null, db: DatabaseClient): Promise<ProjectRecord>;
}

export interface ProjectMemberRepository {
  /**
   * RESOLUTION (not scoped): the explicit role of a user on a project that was just read from the database, or null. The project is
   * passed as a record, not as raw ids, and the query filters by project, organization and user.
   */
  findRoleOn(project: ProjectRecord, userId: string, db?: DatabaseClient): Promise<ProjectRole | null>;
}

export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');
export const PROJECT_MEMBER_REPOSITORY = Symbol('PROJECT_MEMBER_REPOSITORY');
