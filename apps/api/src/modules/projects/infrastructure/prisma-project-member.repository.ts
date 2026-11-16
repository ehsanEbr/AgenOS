import { Injectable } from '@nestjs/common';
import { type ProjectRole, idSchema } from '@agentos/contracts';
import {
  type DatabaseClient,
  PrismaService,
  isForeignKeyViolation,
  isRecordNotFound,
  isUniqueConstraintViolation,
} from '../../database';
import {
  alreadyProjectMember,
  organizationMemberNotFound,
  projectMemberNotFound,
} from '../application/errors';
import type {
  PageOf,
  PageRequest,
  ProjectMemberRepository,
  RemovedProjectMembership,
} from '../application/ports';
import type { ProjectMemberRecord, ProjectRecord } from '../domain/project';
import { type ProjectScope, requireProjectScope } from '../domain/project-context';
import { toProjectMemberRecord } from './prisma-project.repository';

/** Stable page order: oldest first, the id breaks ties, so paging never repeats or skips a row. */
const ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

@Injectable()
export class PrismaProjectMemberRepository implements ProjectMemberRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- resolution --------------------------------------------------------------------------------------------------------------------

  async findRoleOn(
    project: ProjectRecord,
    userId: string,
    db: DatabaseClient = this.prisma,
  ): Promise<ProjectRole | null> {
    const row = await db.projectMember.findFirst({
      where: { projectId: project.id, organizationId: project.organizationId, userId },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  // --- project-scoped ----------------------------------------------------------------------------------------------------------------

  async list(
    scope: ProjectScope,
    page: PageRequest,
    db: DatabaseClient = this.prisma,
  ): Promise<PageOf<ProjectMemberRecord>> {
    const { organizationId, projectId } = requireProjectScope(scope);
    const where = { projectId, organizationId };
    const [rows, total] = await Promise.all([
      db.projectMember.findMany({ where, orderBy: [...ORDER], take: page.limit, skip: page.offset }),
      db.projectMember.count({ where }),
    ]);
    return { total, items: rows.map(toProjectMemberRecord) };
  }

  async find(
    scope: ProjectScope,
    userId: string,
    db: DatabaseClient = this.prisma,
  ): Promise<ProjectMemberRecord | null> {
    const { organizationId, projectId } = requireProjectScope(scope);
    if (!idSchema.safeParse(userId).success) return null;
    const row = await db.projectMember.findFirst({ where: { projectId, organizationId, userId } });
    return row && toProjectMemberRecord(row);
  }

  async add(
    scope: ProjectScope,
    member: { readonly userId: string; readonly role: ProjectRole },
    db: DatabaseClient,
  ): Promise<ProjectMemberRecord> {
    const { organizationId, projectId } = requireProjectScope(scope);
    try {
      return toProjectMemberRecord(
        await db.projectMember.create({
          data: { projectId, organizationId, userId: member.userId, role: member.role },
        }),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw alreadyProjectMember();
      // Not (or no longer) a member of the project's organization: the composite foreign key refused the row.
      if (isForeignKeyViolation(error)) throw organizationMemberNotFound();
      throw error;
    }
  }

  async setRole(
    scope: ProjectScope,
    userId: string,
    role: ProjectRole,
    db: DatabaseClient,
  ): Promise<ProjectMemberRecord> {
    const { organizationId, projectId } = requireProjectScope(scope);
    try {
      return toProjectMemberRecord(
        await db.projectMember.update({
          where: { projectId_userId: { projectId, userId }, organizationId },
          data: { role },
        }),
      );
    } catch (error) {
      if (isRecordNotFound(error)) throw projectMemberNotFound();
      throw error;
    }
  }

  async remove(scope: ProjectScope, userId: string, db: DatabaseClient): Promise<boolean> {
    const { organizationId, projectId } = requireProjectScope(scope);
    const { count } = await db.projectMember.deleteMany({ where: { projectId, organizationId, userId } });
    return count > 0;
  }

  // --- system cleanup ----------------------------------------------------------------------------------------------------------------

  async deleteAllOfUserInOrganization(
    organizationId: string,
    userId: string,
    db: DatabaseClient,
  ): Promise<RemovedProjectMembership[]> {
    if (!idSchema.safeParse(organizationId).success || !idSchema.safeParse(userId).success)
      throw new Error('The project membership cleanup was called with malformed ids');
    // One statement; RETURNING reports the role each row had AT DELETION, which a read followed by a delete could not guarantee.
    // Names are schema-qualified because raw SQL does not use Prisma's schema mapping.
    const rows = await db.$queryRaw<{ id: string; project_id: string; role: ProjectRole }[]>`
      DELETE FROM projects.project_member
       WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid
   RETURNING id, project_id, role`;
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, role: row.role }));
  }
}
