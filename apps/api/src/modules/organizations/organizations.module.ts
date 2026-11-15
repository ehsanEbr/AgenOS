import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { DatabaseModule } from '../database';
import { IdentityModule } from '../identity';
import { AuthorizationService } from './application/authorization.service';
import { MembershipDirectory } from './application/membership-directory';
import { MembershipLifecycle } from './application/membership-lifecycle';
import { MembershipService } from './application/membership.service';
import { OrganizationService } from './application/organization.service';
import { MEMBERSHIP_REPOSITORY, ORGANIZATION_REPOSITORY } from './application/ports';
import { TenantAccess } from './application/tenant-access';
import { PrismaMembershipRepository } from './infrastructure/prisma-membership.repository';
import { PrismaOrganizationRepository } from './infrastructure/prisma-organization.repository';
import { MembersController } from './presentation/members.controller';
import { OrganizationAccessGuard } from './presentation/organization-access.guard';
import { OrganizationsController } from './presentation/organizations.controller';

/**
 * Organizations: where you act and what you may do there (ADR-0010). It owns organizations and memberships, turns a client-supplied
 * organization id into a validated `TenantContext`, and evaluates the code-owned role matrix. It depends on identity (the principal and
 * the user directory) and audit; the projects module will depend on it.
 */
@Module({
  imports: [DatabaseModule, AuditModule, IdentityModule],
  controllers: [OrganizationsController, MembersController],
  providers: [
    { provide: ORGANIZATION_REPOSITORY, useClass: PrismaOrganizationRepository },
    { provide: MEMBERSHIP_REPOSITORY, useClass: PrismaMembershipRepository },
    TenantAccess,
    AuthorizationService,
    MembershipDirectory,
    MembershipLifecycle,
    OrganizationService,
    MembershipService,
    OrganizationAccessGuard,
  ],
  exports: [TenantAccess, AuthorizationService, MembershipDirectory, MembershipLifecycle],
})
export class OrganizationsModule {}
