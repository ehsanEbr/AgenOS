import { Inject, Injectable } from '@nestjs/common';
import { idSchema } from '@agentos/contracts';
import type { DatabaseClient } from '../../database';
import type { TenantContext } from '../domain/tenant';
import { organizationNotFound } from './errors';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './ports';

/**
 * The one place an organization id becomes a `TenantContext` (ADR-0010, decision 4.1).
 *
 * The id a client sends is only a SELECTOR: it is accepted if, and only if, the authenticated user is a member, read from the database
 * now (no role is cached in the session or anywhere else, so a demotion or removal applies on the next request). A malformed id, an
 * organization that does not exist and an organization the caller does not belong to all give the same 404.
 */
@Injectable()
export class TenantAccess {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository) {}

  /** Pass `db` to re-check inside a transaction (membership changes do, so the role they act with is the committed one). */
  async resolve(
    subject: { readonly userId: string },
    organizationId: string,
    db?: DatabaseClient,
  ): Promise<TenantContext> {
    if (!idSchema.safeParse(organizationId).success) throw organizationNotFound();
    const membership = await this.memberships.find(organizationId, subject.userId, db);
    if (!membership) throw organizationNotFound();
    return { organizationId: membership.organizationId, userId: membership.userId, role: membership.role };
  }
}
