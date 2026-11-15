import { Injectable } from '@nestjs/common';
import type { ProjectRole } from '@agentos/contracts';
import { type DatabaseClient, PrismaService } from '../../database';
import type { ProjectMemberRepository } from '../application/ports';
import type { ProjectRecord } from '../domain/project';

@Injectable()
export class PrismaProjectMemberRepository implements ProjectMemberRepository {
  constructor(private readonly prisma: PrismaService) {}

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
}
