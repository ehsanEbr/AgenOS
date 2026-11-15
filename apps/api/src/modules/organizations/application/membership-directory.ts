import { Inject, Injectable } from '@nestjs/common';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './ports';
import type { DatabaseClient } from '../../database';

/**
 * What other modules may ask about membership (ADR-0010, decision 1). Plain facts, no role and no Prisma type: a module that needs a
 * permission asks `AuthorizationService` through a `TenantContext`; it never decides access from these answers.
 *
 * The projects module uses it for "the project member must belong to the organization" and for id-addressed lookups
 * (`WHERE organization_id IN organizationIdsOf(user)`).
 */
@Injectable()
export class MembershipDirectory {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository) {}

  async isMember(organizationId: string, userId: string, db?: DatabaseClient): Promise<boolean> {
    return (await this.memberships.find(organizationId, userId, db)) !== null;
  }

  organizationIdsOf(userId: string, db?: DatabaseClient): Promise<string[]> {
    return this.memberships.organizationIdsOf(userId, db);
  }
}
