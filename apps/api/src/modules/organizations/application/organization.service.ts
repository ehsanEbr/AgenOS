import { Inject, Injectable } from '@nestjs/common';
import { AuditRecorder } from '../../audit';
import { TransactionRunner } from '../../database';
import type { MembershipOfUser } from '../domain/organization';
import { type TenantContext, scopeOf } from '../domain/tenant';
import { AuthorizationService } from './authorization.service';
import { organizationNotFound } from './errors';
import {
  MEMBERSHIP_REPOSITORY,
  ORGANIZATION_REPOSITORY,
  type MembershipRepository,
  type OrganizationRepository,
  type PageOf,
  type PageRequest,
} from './ports';
import { TenantAccess } from './tenant-access';

/** Organizations: create, list the caller's, read and rename (ADR-0010, decisions 4, 5 and 6). */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository,
    private readonly tenants: TenantAccess,
    private readonly authorization: AuthorizationService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Any authenticated user may create an organization and becomes its owner. The organization, its first membership and the audit
   * events commit together or not at all, so an organization never exists without an owner.
   */
  create(creator: { readonly userId: string }, name: string): Promise<MembershipOfUser> {
    return this.transactions.run(async (tx) => {
      const { organization, membership } = await this.organizations.createWithOwner(name, creator.userId, tx);
      const common = { actorUserId: creator.userId, organizationId: organization.id } as const;
      await this.audit.record(
        {
          ...common,
          action: 'organization.created',
          resourceType: 'organization',
          result: 'success',
          resourceId: organization.id,
          metadata: {},
        },
        tx,
      );
      await this.audit.record(
        {
          ...common,
          action: 'membership.added',
          resourceType: 'membership',
          result: 'success',
          resourceId: membership.id,
          metadata: { userId: creator.userId, role: 'owner' },
        },
        tx,
      );
      await this.audit.record(
        {
          ...common,
          action: 'organization.owner_granted',
          resourceType: 'membership',
          result: 'success',
          resourceId: membership.id,
          metadata: { userId: creator.userId },
        },
        tx,
      );
      return { organization, role: 'owner' };
    });
  }

  /** The organizations the user belongs to, each with the user's own role. Nothing else is ever listed. */
  listOf(user: { readonly userId: string }, page: PageRequest): Promise<PageOf<MembershipOfUser>> {
    return this.memberships.listOrganizationsOf(user.userId, page);
  }

  async get(tenant: TenantContext): Promise<MembershipOfUser> {
    const organization = await this.organizations.findById(scopeOf(tenant));
    if (!organization) throw organizationNotFound();
    return { organization, role: tenant.role };
  }

  /** Renames the organization. The role is re-read inside the transaction, so a demotion that just committed already applies. */
  rename(tenant: TenantContext, name: string): Promise<MembershipOfUser> {
    return this.transactions.run(async (tx) => {
      const current = await this.tenants.resolve(tenant, tenant.organizationId, tx);
      this.authorization.authorize(current, 'organization.update');
      const scope = scopeOf(current);

      const existing = await this.organizations.findById(scope, tx);
      if (!existing) throw organizationNotFound();
      if (existing.name === name) return { organization: existing, role: current.role }; // nothing changed, nothing to audit

      const organization = await this.organizations.updateName(scope, name, tx);
      await this.audit.record(
        {
          action: 'organization.updated',
          resourceType: 'organization',
          result: 'success',
          actorUserId: current.userId,
          organizationId: organization.id,
          resourceId: organization.id,
          metadata: { changedFields: ['name'] },
        },
        tx,
      );
      return { organization, role: current.role };
    });
  }
}
