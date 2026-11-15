import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type OrganizationWithRole,
  type Paginated,
  createOrganizationRequestSchema,
  organizationWithRoleSchema,
  paginatedSchema,
  paginationQuerySchema,
  updateOrganizationRequestSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { CurrentPrincipal, type Principal } from '../../identity';
import { OrganizationService } from '../application/organization.service';
import type { TenantContext } from '../domain/tenant';
import { CurrentTenant, RequirePermission } from './decorators';
import { toOrganizationWithRoleDto } from './mappers';
import { OrganizationAccessGuard } from './organization-access.guard';

class CreateOrganizationDto extends createZodDto(createOrganizationRequestSchema) {}
class UpdateOrganizationDto extends createZodDto(updateOrganizationRequestSchema) {}
class PageQueryDto extends createZodDto(paginationQuerySchema) {}

@ApiTags('organizations')
@ApiBearerAuth()
@ApiCookieAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationService) {}

  // The two routes below name no organization: they act on the caller's own account (authenticated by the global guard) and list or
  // create only what the caller belongs to or becomes the owner of. They are the account-scoped routes of this module.

  @Get()
  @ApiOperation({ summary: 'The organizations the signed-in user belongs to, with their role in each.' })
  @ApiZodQuery(paginationQuerySchema)
  @ApiZodResponse(200, paginatedSchema(organizationWithRoleSchema))
  @ApiStandardErrors(400, 401)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<OrganizationWithRole>> {
    const { items, total } = await this.organizations.listOf(principal, query);
    return {
      items: items.map(toOrganizationWithRoleDto),
      page: { limit: query.limit, offset: query.offset, total },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create an organization. The caller becomes its owner.' })
  @ApiZodBody(createOrganizationRequestSchema)
  @ApiZodResponse(201, organizationWithRoleSchema)
  @ApiStandardErrors(400, 401)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateOrganizationDto,
  ): Promise<OrganizationWithRole> {
    return toOrganizationWithRoleDto(await this.organizations.create(principal, body.name));
  }

  @Get(':organizationId')
  @UseGuards(OrganizationAccessGuard)
  @RequirePermission('organization.read')
  @ApiOperation({ summary: 'One organization the caller belongs to. A non-member gets 404.' })
  @ApiZodResponse(200, organizationWithRoleSchema)
  @ApiStandardErrors(401, 404)
  async get(@CurrentTenant() tenant: TenantContext): Promise<OrganizationWithRole> {
    return toOrganizationWithRoleDto(await this.organizations.get(tenant));
  }

  @Patch(':organizationId')
  @HttpCode(200)
  @UseGuards(OrganizationAccessGuard)
  @RequirePermission('organization.update')
  @ApiOperation({ summary: 'Rename the organization.' })
  @ApiZodBody(updateOrganizationRequestSchema)
  @ApiZodResponse(200, organizationWithRoleSchema)
  @ApiStandardErrors(400, 401, 403, 404)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: UpdateOrganizationDto,
  ): Promise<OrganizationWithRole> {
    return toOrganizationWithRoleDto(await this.organizations.rename(tenant, body.name));
  }
}
