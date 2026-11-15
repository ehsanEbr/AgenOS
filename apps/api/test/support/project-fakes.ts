import { randomUUID } from 'node:crypto';
import type { ProjectRole } from '@agentos/contracts';
import type {
  NewProject,
  PageOf,
  PageRequest,
  ProjectMemberRepository,
  ProjectRepository,
  ProjectStatusFilter,
} from '../../src/modules/projects/application/ports';
import { projectSlugTaken } from '../../src/modules/projects/application/errors';
import type {
  ProjectMemberRecord,
  ProjectRecord,
  ProjectView,
} from '../../src/modules/projects/domain/project';
import { type ProjectScope, requireProjectScope } from '../../src/modules/projects/domain/project-context';
import type { ProjectVisibility } from '../../src/modules/projects/domain/visibility';
import { type OrganizationScope, requireScope } from '../../src/modules/organizations';

/*
 * In-memory stand-ins for the projects ports, so the application services can be tested without PostgreSQL. They honor the same contract
 * as the real repositories, scopes included: a missing or forged scope throws. What they CANNOT show is concurrency and the database
 * constraints; those are tested against real PostgreSQL in projects.int.spec.ts and projects-database.int.spec.ts.
 */

export class InMemoryProjects implements ProjectRepository {
  readonly rows = new Map<string, ProjectRecord>();
  /** Count of calls that took the project lock, to prove every change takes it. */
  lockCalls = 0;
  readonly members: InMemoryProjectMembers;

  constructor(members: InMemoryProjectMembers) {
    this.members = members;
  }

  seed(organizationId: string, slug: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const project: ProjectRecord = {
      id: randomUUID(),
      organizationId,
      name: `Project ${slug}`,
      slug,
      description: null,
      status: 'active',
      archivedAt: null,
      createdAt: new Date(now.getTime() + this.rows.size * 1000),
      updatedAt: now,
      ...overrides,
    };
    this.rows.set(project.id, project);
    return project;
  }

  findInOrganizations(organizationIds: readonly string[], projectId: string) {
    const row = this.rows.get(projectId);
    return Promise.resolve(row && organizationIds.includes(row.organizationId) ? row : null);
  }

  createWithCreator(scope: OrganizationScope, project: NewProject, creatorUserId: string) {
    const { organizationId } = requireScope(scope);
    if (
      [...this.rows.values()].some(
        (row) => row.organizationId === organizationId && row.slug === project.slug,
      )
    )
      return Promise.reject(projectSlugTaken());
    const created = this.seed(organizationId, project.slug, {
      name: project.name,
      description: project.description,
    });
    const member = this.members.insert(created, creatorUserId, 'project_admin');
    return Promise.resolve({ project: created, member });
  }

  list(
    scope: OrganizationScope,
    visibility: ProjectVisibility,
    status: ProjectStatusFilter,
    page: PageRequest,
  ): Promise<PageOf<ProjectView>> {
    const { organizationId } = requireScope(scope);
    if (!visibility || !['organization', 'explicit'].includes(visibility.kind))
      throw new Error('invalid visibility');
    const visible = [...this.rows.values()]
      .filter((row) => row.organizationId === organizationId)
      .filter((row) => (status === 'all' ? true : row.status === status))
      .filter(
        (row) =>
          visibility.kind === 'organization' || this.members.roleOf(row.id, visibility.userId) !== null,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return Promise.resolve({
      total: visible.length,
      items: visible
        .slice(page.offset, page.offset + page.limit)
        .map((project) => ({ project, projectRole: this.members.roleOf(project.id, visibility.userId) })),
    });
  }

  lock(scope: ProjectScope) {
    const { organizationId, projectId } = requireProjectScope(scope);
    this.lockCalls += 1;
    const row = this.rows.get(projectId);
    return Promise.resolve(row && row.organizationId === organizationId ? row : null);
  }

  update(scope: ProjectScope, changes: { name?: string; description?: string | null }) {
    const { projectId } = requireProjectScope(scope);
    const current = this.rows.get(projectId)!;
    const updated = { ...current, ...changes, updatedAt: new Date('2026-03-02T12:00:00.000Z') };
    this.rows.set(projectId, updated);
    return Promise.resolve(updated);
  }

  setArchived(scope: ProjectScope, archivedAt: Date | null) {
    const { projectId } = requireProjectScope(scope);
    const current = this.rows.get(projectId)!;
    const updated: ProjectRecord = { ...current, status: archivedAt ? 'archived' : 'active', archivedAt };
    this.rows.set(projectId, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryProjectMembers implements ProjectMemberRepository {
  readonly rows: ProjectMemberRecord[] = [];

  insert(project: ProjectRecord, userId: string, role: ProjectRole): ProjectMemberRecord {
    const member: ProjectMemberRecord = {
      id: randomUUID(),
      projectId: project.id,
      organizationId: project.organizationId,
      userId,
      role,
      createdAt: new Date('2026-03-01T12:00:00.000Z'),
    };
    this.rows.push(member);
    return member;
  }

  roleOf(projectId: string, userId: string): ProjectRole | null {
    return this.rows.find((row) => row.projectId === projectId && row.userId === userId)?.role ?? null;
  }

  findRoleOn(project: ProjectRecord, userId: string) {
    return Promise.resolve(
      this.rows.find(
        (row) =>
          row.projectId === project.id &&
          row.organizationId === project.organizationId &&
          row.userId === userId,
      )?.role ?? null,
    );
  }
}
