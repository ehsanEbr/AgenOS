import type { OrganizationRole } from '@agentos/contracts';
import type { DatabaseClient } from '../../database';
import type { MembershipOfUser, MembershipRecord, OrganizationRecord } from '../domain/organization';
import type { OrganizationScope } from '../domain/tenant';

/*
 * Ports of the organizations application layer. They live here, not in the domain, because repository methods carry the transaction
 * handle (`DatabaseClient`). Infrastructure implements them.
 *
 * TENANT RULE (ADR-0010, decision 4.2): every method that reads or writes data OF an organization takes an `OrganizationScope` as its
 * first parameter and refuses to run without a genuine one. The few methods keyed by a user instead are marked; they are how a scope is
 * earned (membership lookup) or list "my" organizations, and they filter by that user in the same statement.
 */

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export interface PageOf<T> {
  readonly items: T[];
  readonly total: number;
}

export interface OrganizationRepository {
  /** Creates an organization and its first owner membership in one statement (so an organization never exists without an owner). */
  createWithOwner(
    name: string,
    ownerUserId: string,
    db: DatabaseClient,
  ): Promise<{ organization: OrganizationRecord; membership: MembershipRecord }>;
  findById(scope: OrganizationScope, db?: DatabaseClient): Promise<OrganizationRecord | null>;
  updateName(scope: OrganizationScope, name: string, db: DatabaseClient): Promise<OrganizationRecord>;
}

export interface NewMembership {
  readonly userId: string;
  readonly role: OrganizationRole;
}

export interface MembershipRepository {
  /** Keyed by user: resolves "is this user a member of this organization", which is how a `TenantContext` is earned. */
  find(organizationId: string, userId: string, db?: DatabaseClient): Promise<MembershipRecord | null>;
  /** Keyed by user: the organizations of one user with their role, and the total count. */
  listOrganizationsOf(
    userId: string,
    page: PageRequest,
    db?: DatabaseClient,
  ): Promise<PageOf<MembershipOfUser>>;
  /** Keyed by user: the ids of every organization the user belongs to. */
  organizationIdsOf(userId: string, db?: DatabaseClient): Promise<string[]>;

  list(scope: OrganizationScope, page: PageRequest, db?: DatabaseClient): Promise<PageOf<MembershipRecord>>;
  findMember(scope: OrganizationScope, userId: string, db?: DatabaseClient): Promise<MembershipRecord | null>;
  /**
   * Locks the owner memberships of the organization until the transaction ends and returns the user ids of its owners as they are
   * AFTER the lock was acquired. Every membership change takes this lock first, so changes to one organization's memberships run one
   * after another and the last-owner check sees the committed result of the one before it.
   */
  lockOwners(scope: OrganizationScope, db: DatabaseClient): Promise<string[]>;
  add(scope: OrganizationScope, membership: NewMembership, db: DatabaseClient): Promise<MembershipRecord>;
  setRole(
    scope: OrganizationScope,
    userId: string,
    role: OrganizationRole,
    db: DatabaseClient,
  ): Promise<MembershipRecord>;
  /** True when a membership was removed. */
  remove(scope: OrganizationScope, userId: string, db: DatabaseClient): Promise<boolean>;
}

export const ORGANIZATION_REPOSITORY = Symbol('ORGANIZATION_REPOSITORY');
export const MEMBERSHIP_REPOSITORY = Symbol('MEMBERSHIP_REPOSITORY');
