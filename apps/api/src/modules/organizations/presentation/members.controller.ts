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
  type Member,
  type Paginated,
  addMemberRequestSchema,
  idSchema,
  memberSchema,
  paginatedSchema,
  paginationQuerySchema,
  updateMemberRequestSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { MembershipService } from '../application/membership.service';
import type { TenantContext } from '../domain/tenant';
import { CurrentTenant, RequirePermission } from './decorators';
import { toMemberDto } from './mappers';
import { OrganizationAccessGuard } from './organization-access.guard';

class AddMemberDto extends createZodDto(addMemberRequestSchema) {}
class UpdateMemberDto extends createZodDto(updateMemberRequestSchema) {}
class PageQueryDto extends createZodDto(paginationQuerySchema) {}
class MemberParamsDto extends createZodDto(z.object({ userId: idSchema })) {}

/**
 * Memberships of one organization. The guard resolves `:organizationId` against the caller's membership (404 for a non-member) and
 * checks the declared permission (403); `MembershipService` then applies the ownership and last-owner rules.
 */
@ApiTags('organizations')
@ApiBearerAuth()
@ApiCookieAuth()
@UseGuards(OrganizationAccessGuard)
@Controller('organizations/:organizationId/members')
export class MembersController {
  constructor(private readonly members: MembershipService) {}

  @Get()
  @RequirePermission('member.read')
  @ApiOperation({ summary: 'The members of the organization and their roles.' })
  @ApiZodQuery(paginationQuerySchema)
  @ApiZodResponse(200, paginatedSchema(memberSchema))
  @ApiStandardErrors(400, 401, 404)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<Member>> {
    const { items, total } = await this.members.list(tenant, query);
    return { items: items.map(toMemberDto), page: { limit: query.limit, offset: query.offset, total } };
  }

  @Post()
  @RequirePermission('member.manage')
  @ApiOperation({
    summary:
      'Add an existing user, by email. Making someone an owner needs the owner role. There are no invitations: an unknown email is 404 user_not_found.',
  })
  @ApiZodBody(addMemberRequestSchema)
  @ApiZodResponse(201, memberSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async add(@CurrentTenant() tenant: TenantContext, @Body() body: AddMemberDto): Promise<Member> {
    return toMemberDto(await this.members.add(tenant, body));
  }

  @Patch(':userId')
  @HttpCode(200)
  @RequirePermission('member.manage')
  @ApiOperation({
    summary:
      'Change a member role. Granting or revoking owner needs the owner role, and the last owner cannot be demoted (409 last_owner).',
  })
  @ApiZodBody(updateMemberRequestSchema)
  @ApiZodResponse(200, memberSchema)
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async changeRole(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: MemberParamsDto,
    @Body() body: UpdateMemberDto,
  ): Promise<Member> {
    return toMemberDto(await this.members.changeRole(tenant, params.userId, body.role));
  }

  @Delete(':userId')
  @HttpCode(204)
  // Declared as `member.read` (every member holds it) because LEAVING needs nothing more than membership: the service requires
  // `member.manage` to remove somebody else, `member.manage_owners` to remove an owner, and refuses to remove the last owner.
  @RequirePermission('member.read')
  @ApiOperation({
    summary:
      'Remove a member, or leave the organization by removing yourself. The last owner cannot be removed (409 last_owner).',
  })
  @ApiStandardErrors(400, 401, 403, 404, 409)
  async remove(@CurrentTenant() tenant: TenantContext, @Param() params: MemberParamsDto): Promise<void> {
    await this.members.remove(tenant, params.userId);
  }
}
