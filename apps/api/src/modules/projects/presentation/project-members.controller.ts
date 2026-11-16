import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  type Paginated,
  type ProjectMember,
  addProjectMemberRequestSchema,
  idSchema,
  paginatedSchema,
  paginationQuerySchema,
  projectMemberSchema,
  updateProjectMemberRequestSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { ProjectMemberService, type ProjectMemberView } from '../application/project-member.service';
import type { ProjectContext } from '../domain/project-context';
import { CurrentProject, RequireProjectPermission } from './decorators';
import { ProjectAccessGuard } from './project-access.guard';

class AddProjectMemberDto extends createZodDto(addProjectMemberRequestSchema) {}
class UpdateProjectMemberDto extends createZodDto(updateProjectMemberRequestSchema) {}
class PageQueryDto extends createZodDto(paginationQuerySchema) {}
class MemberParamsDto extends createZodDto(z.object({ userId: idSchema })) {}

function toProjectMemberDto({ member, user }: ProjectMemberView): ProjectMember {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: member.role,
    joinedAt: member.createdAt.toISOString(),
  };
}

/**
 * The members of one project. The guard finds the project among the caller's organizations (anything they cannot see is the same 404)
 * and checks the declared permission; `ProjectMemberService` then applies the rules inside its transaction. Owners and admins of the
 * organization have implicit access and are listed here only if they also hold a project membership.
 */
@ApiTags('projects')
@ApiBearerAuth()
@ApiCookieAuth()
@UseGuards(ProjectAccessGuard)
@Controller('projects/:projectId/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMemberService) {}

  @Get()
  @RequireProjectPermission('project.read')
  @ApiOperation({
    summary: 'The explicit members of a project the caller can access, with their project role.',
  })
  @ApiZodQuery(paginationQuerySchema)
  @ApiZodResponse(200, paginatedSchema(projectMemberSchema))
  @ApiStandardErrors(400, 401, 404)
  async list(
    @CurrentProject() project: ProjectContext,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<ProjectMember>> {
    const { items, total } = await this.members.list(project, query);
    return {
      items: items.map(toProjectMemberDto),
      page: { limit: query.limit, offset: query.offset, total },
    };
  }

  @Post()
  @RequireProjectPermission('project.member.manage')
  @ApiOperation({
    summary:
      'Add an existing member of the project organization, by user id. An unknown user and a user outside the organization both answer 404 organization_member_not_found.',
  })
  @ApiZodBody(addProjectMemberRequestSchema)
  @ApiZodResponse(201, projectMemberSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async add(
    @CurrentProject() project: ProjectContext,
    @Body() body: AddProjectMemberDto,
  ): Promise<ProjectMember> {
    return toProjectMemberDto(await this.members.add(project, body));
  }

  @Patch(':userId')
  @HttpCode(200)
  @RequireProjectPermission('project.member.manage')
  @ApiOperation({ summary: 'Change a project member role.' })
  @ApiZodBody(updateProjectMemberRequestSchema)
  @ApiZodResponse(200, projectMemberSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async changeRole(
    @CurrentProject() project: ProjectContext,
    @Param() params: MemberParamsDto,
    @Body() body: UpdateProjectMemberDto,
  ): Promise<ProjectMember> {
    return toProjectMemberDto(await this.members.changeRole(project, params.userId, body.projectRole));
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequireProjectPermission('project.member.manage')
  @ApiOperation({ summary: 'Remove a project member. Their organization membership is unaffected.' })
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async remove(@CurrentProject() project: ProjectContext, @Param() params: MemberParamsDto): Promise<void> {
    await this.members.remove(project, params.userId);
  }
}
