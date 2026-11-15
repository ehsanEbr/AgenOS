import { Injectable } from '@nestjs/common';
import type { Prisma, Project, ProjectMember } from '@prisma/client';
import { idSchema } from '@agentos/contracts';
import {
  type DatabaseClient,
  PrismaService,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from '../../database';
import { type OrganizationScope, requireScope } from '../../organizations';
import { organizationNotFound, projectSlugTaken } from '../application/errors';
import type {
  NewProject,
  PageOf,
  PageRequest,
  ProjectRepository,
  ProjectStatusFilter,
} from '../application/ports';
import type { ProjectMemberRecord, ProjectRecord, ProjectView } from '../domain/project';
import { type ProjectScope, requireProjectScope } from '../domain/project-context';
import type { ProjectVisibility } from '../domain/visibility';

export function toProjectRecord(row: Project): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProjectMemberRecord(row: ProjectMember): ProjectMemberRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
  };
}

/** Stable page order: oldest first, the id breaks ties, so paging never repeats or skips a row. */
const ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

function requireVisibility(visibility: ProjectVisibility): ProjectVisibility {
  if (
    !visibility ||
    (visibility.kind !== 'organization' && visibility.kind !== 'explicit') ||
    !idSchema.safeParse(visibility.userId).success
  )
    throw new Error('A project listing was requested without a valid ProjectVisibility');
  return visibility;
}

@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- resolution: the one id-only lookup ------------------------------------------------------------------------------------------

  async findInOrganizations(
    organizationIds: readonly string[],
    projectId: string,
    db: DatabaseClient = this.prisma,
  ): Promise<ProjectRecord | null> {
    if (
      organizationIds.length === 0 ||
      !idSchema.safeParse(projectId).success ||
      !organizationIds.every((id) => idSchema.safeParse(id).success)
    )
      return null; // nothing to search in, or nothing well-formed: no query
    const row = await db.project.findFirst({
      where: { id: projectId, organizationId: { in: [...organizationIds] } },
    });
    return row && toProjectRecord(row);
  }

  // --- organization-scoped ------------------------------------------------------------------------------------------------------------

  async createWithCreator(
    scope: OrganizationScope,
    project: NewProject,
    creatorUserId: string,
    db: DatabaseClient,
  ): Promise<{ project: ProjectRecord; member: ProjectMemberRecord }> {
    const { organizationId } = requireScope(scope);
    // Two statements on the SAME transaction handle: the project, then its creator's membership. Either failing rolls both back.
    let row: Project;
    try {
      row = await db.project.create({
        data: {
          organizationId,
          name: project.name,
          slug: project.slug,
          description: project.description,
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw projectSlugTaken();
      throw error;
    }
    try {
      const member = await db.projectMember.create({
        data: { projectId: row.id, organizationId, userId: creatorUserId, role: 'project_admin' },
      });
      return { project: toProjectRecord(row), member: toProjectMemberRecord(member) };
    } catch (error) {
      // The creator is not (or no longer) a member of the organization: the composite foreign key refused the membership row.
      if (isForeignKeyViolation(error)) throw organizationNotFound();
      throw error;
    }
  }

  async list(
    scope: OrganizationScope,
    visibility: ProjectVisibility,
    status: ProjectStatusFilter,
    page: PageRequest,
    db: DatabaseClient = this.prisma,
  ): Promise<PageOf<ProjectView>> {
    const { organizationId } = requireScope(scope);
    const { kind, userId } = requireVisibility(visibility);
    // Visibility is part of the predicate, so the page, the count and the filter all see only what the caller may see.
    const where: Prisma.ProjectWhereInput = {
      organizationId,
      ...(status === 'all' ? {} : { status }),
      ...(kind === 'explicit' ? { members: { some: { organizationId, userId } } } : {}),
    };
    const [rows, total] = await Promise.all([
      db.project.findMany({
        where,
        include: { members: { where: { userId }, select: { role: true }, take: 1 } },
        orderBy: [...ORDER],
        take: page.limit,
        skip: page.offset,
      }),
      db.project.count({ where }),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        project: toProjectRecord(row),
        projectRole: row.members[0]?.role ?? null,
      })),
    };
  }

  // --- project-scoped -----------------------------------------------------------------------------------------------------------------

  async lock(scope: ProjectScope, db: DatabaseClient): Promise<ProjectRecord | null> {
    const { organizationId, projectId } = requireProjectScope(scope);
    // The lock first, then a separate read: the second statement takes a fresh snapshot, so it returns what the transaction that held the
    // lock before us committed. Names are schema-qualified because raw SQL ignores Prisma's mapping.
    await db.$queryRaw`
      SELECT id FROM projects.project
       WHERE id = ${projectId}::uuid AND organization_id = ${organizationId}::uuid
         FOR UPDATE`;
    const row = await db.project.findFirst({ where: { id: projectId, organizationId } });
    return row && toProjectRecord(row);
  }

  async update(
    scope: ProjectScope,
    changes: { readonly name?: string; readonly description?: string | null },
    db: DatabaseClient,
  ): Promise<ProjectRecord> {
    const { organizationId, projectId } = requireProjectScope(scope);
    return toProjectRecord(
      await db.project.update({
        where: { id_organizationId: { id: projectId, organizationId } },
        data: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
        },
      }),
    );
  }

  async setArchived(
    scope: ProjectScope,
    archivedAt: Date | null,
    db: DatabaseClient,
  ): Promise<ProjectRecord> {
    const { organizationId, projectId } = requireProjectScope(scope);
    return toProjectRecord(
      await db.project.update({
        where: { id_organizationId: { id: projectId, organizationId } },
        data: { status: archivedAt ? 'archived' : 'active', archivedAt },
      }),
    );
  }
}
