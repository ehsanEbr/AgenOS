import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Paginated,
  type Project,
  createProjectRequestSchema,
  listProjectsQuerySchema,
  paginatedSchema,
  projectSchema,
  updateProjectRequestSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { ProjectService } from '../application/project.service';
import type { OrganizationContext, ProjectContext } from '../domain/project-context';
import {
  CurrentOrganization,
  CurrentProject,
  RequireOrganizationPermission,
  RequireProjectPermission,
} from './decorators';
import { toProjectDto } from './mappers';
import { ProjectAccessGuard } from './project-access.guard';

class CreateProjectDto extends createZodDto(createProjectRequestSchema) {}
class UpdateProjectDto extends createZodDto(updateProjectRequestSchema) {}
class ListProjectsQueryDto extends createZodDto(listProjectsQuerySchema) {}

/**
 * Projects (ADR-0011). Every route is under `ProjectAccessGuard` and declares how it reaches its tenant and which permission it needs;
 * `test/route-metadata.e2e.spec.ts` pins both for each route.
 */
@ApiTags('projects')
@ApiBearerAuth()
@ApiCookieAuth()
@UseGuards(ProjectAccessGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectService) {}

  @Get()
  @RequireOrganizationPermission('project.list', 'query')
  @ApiOperation({
    summary:
      'The projects of an organization that the caller can access. Owners and admins see every project; members and viewers only those they belong to.',
  })
  @ApiZodQuery(listProjectsQuerySchema)
  @ApiZodResponse(200, paginatedSchema(projectSchema))
  @ApiStandardErrors(400, 401, 403, 404)
  async list(
    @CurrentOrganization() organization: OrganizationContext,
    @Query() query: ListProjectsQueryDto,
  ): Promise<Paginated<Project>> {
    const { items, total } = await this.projects.list(organization, query);
    return { items: items.map(toProjectDto), page: { limit: query.limit, offset: query.offset, total } };
  }

  @Post()
  @RequireOrganizationPermission('project.create', 'body')
  @ApiOperation({ summary: 'Create a project. The caller becomes its project_admin.' })
  @ApiZodBody(createProjectRequestSchema)
  @ApiZodResponse(201, projectSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async create(
    @CurrentOrganization() organization: OrganizationContext,
    @Body() body: CreateProjectDto,
  ): Promise<Project> {
    return toProjectDto(await this.projects.create(organization, body));
  }

  @Get(':projectId')
  @RequireProjectPermission('project.read')
  @ApiOperation({ summary: 'One project the caller can access. Anything else is 404.' })
  @ApiZodResponse(200, projectSchema)
  @ApiStandardErrors(401, 404)
  get(@CurrentProject() project: ProjectContext): Project {
    return toProjectDto(this.projects.get(project));
  }

  @Patch(':projectId')
  @HttpCode(200)
  @RequireProjectPermission('project.update')
  @ApiOperation({ summary: 'Change the name and description. The organization and the slug cannot change.' })
  @ApiZodBody(updateProjectRequestSchema)
  @ApiZodResponse(200, projectSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async update(@CurrentProject() project: ProjectContext, @Body() body: UpdateProjectDto): Promise<Project> {
    return toProjectDto(await this.projects.update(project, body));
  }

  @Post(':projectId/archive')
  @HttpCode(200)
  @RequireProjectPermission('project.archive')
  @ApiOperation({
    summary: 'Archive the project. Repeating it changes nothing and answers 200 with the same project.',
  })
  @ApiZodResponse(200, projectSchema)
  @ApiStandardErrors(401, 403, 404)
  async archive(@CurrentProject() project: ProjectContext): Promise<Project> {
    return toProjectDto(await this.projects.archive(project));
  }

  @Post(':projectId/restore')
  @HttpCode(200)
  @RequireProjectPermission('project.archive')
  @ApiOperation({
    summary:
      'Restore an archived project. Repeating it changes nothing and answers 200 with the same project.',
  })
  @ApiZodResponse(200, projectSchema)
  @ApiStandardErrors(401, 403, 404)
  async restore(@CurrentProject() project: ProjectContext): Promise<Project> {
    return toProjectDto(await this.projects.restore(project));
  }
}
