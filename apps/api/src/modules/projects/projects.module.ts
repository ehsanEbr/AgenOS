import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { DatabaseModule } from '../database';
import { IdentityModule } from '../identity';
import { OrganizationsModule } from '../organizations';
import { PROJECT_MEMBER_REPOSITORY, PROJECT_REPOSITORY } from './application/ports';
import { ProjectAccess } from './application/project-access';
import { ProjectMemberService } from './application/project-member.service';
import { ProjectMembershipCleanup } from './application/project-membership-cleanup';
import { ProjectService } from './application/project.service';
import { PrismaProjectMemberRepository } from './infrastructure/prisma-project-member.repository';
import { PrismaProjectRepository } from './infrastructure/prisma-project.repository';
import { ProjectAccessGuard } from './presentation/project-access.guard';
import { ProjectMembersController } from './presentation/project-members.controller';
import { ProjectsController } from './presentation/projects.controller';

/**
 * Projects: what an organization's members work on (ADR-0011). It owns projects and project memberships. It depends on organizations
 * (the tenant, the permission matrix, the membership directory), identity (the principal, the user directory) and audit; nothing
 * depends on it.
 */
@Module({
  imports: [DatabaseModule, AuditModule, IdentityModule, OrganizationsModule],
  controllers: [ProjectsController, ProjectMembersController],
  providers: [
    { provide: PROJECT_REPOSITORY, useClass: PrismaProjectRepository },
    { provide: PROJECT_MEMBER_REPOSITORY, useClass: PrismaProjectMemberRepository },
    ProjectAccess,
    ProjectService,
    ProjectMemberService,
    ProjectMembershipCleanup, // registers itself with the organizations module and is checked at bootstrap
    ProjectAccessGuard,
  ],
})
export class ProjectsModule {}
