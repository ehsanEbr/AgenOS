import { Inject, Injectable } from '@nestjs/common';
import type { AuditEventInput, OrganizationRole } from '@agentos/contracts';
import { UserDirectory, type UserSummary } from '../../identity';
import { AuditRecorder } from '../../audit';
import {
  type DatabaseClient,
  TransactionRunner,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from '../../database';
import type { MembershipRecord } from '../domain/organization';
import { leavesNoOwner, permissionsToChangeMembership } from '../domain/membership-policy';
import { type TenantContext, scopeOf } from '../domain/tenant';
import { AuthorizationService } from './authorization.service';
import { alreadyMember, lastOwner, memberNotFound, membershipInUse, userNotFound } from './errors';
import { MembershipLifecycle } from './membership-lifecycle';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository, type PageOf, type PageRequest } from './ports';
import { TenantAccess } from './tenant-access';

/** The action and metadata of an audit event about a membership (the rest is the same for all of them). */
type MembershipEventBody<E = Extract<AuditEventInput, { resourceType: 'membership' }>> = E extends unknown
  ? E extends { action: unknown; metadata: unknown }
    ? { action: E['action']; metadata: E['metadata'] }
    : never
  : never;

/** A membership with the identity facts about the member (read through the public `UserDirectory`, never from Identity's tables). */
export interface MemberView {
  readonly membership: MembershipRecord;
  readonly user: UserSummary;
}

/**
 * Memberships of one organization: list, add, change a role, remove (ADR-0010, decision 5).
 *
 * EVERY change follows the same steps inside one transaction:
 *   1. lock the organization's owner memberships (`lockOwners`), so changes to one organization's memberships run one after another;
 *   2. re-read the ACTOR's role (the one resolved by the request guard may be a moment old) and authorize it;
 *   3. read the target, apply the domain rules (ownership needs `member.manage_owners`; the last owner cannot go);
 *   4. write the change and its audit events.
 * Steps 1-3 are why two concurrent demotions cannot each see "another owner exists" and leave none.
 */
@Injectable()
export class MembershipService {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository,
    private readonly users: UserDirectory,
    private readonly tenants: TenantAccess,
    private readonly authorization: AuthorizationService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
    private readonly lifecycle: MembershipLifecycle,
  ) {}

  async list(tenant: TenantContext, page: PageRequest): Promise<PageOf<MemberView>> {
    const result = await this.memberships.list(scopeOf(tenant), page);
    return { total: result.total, items: await this.withUsers(result.items) };
  }

  /** Adds an EXISTING, active user by email. */
  async add(tenant: TenantContext, input: { email: string; role: OrganizationRole }): Promise<MemberView> {
    const user = await this.users.findByEmail(input.email);
    return this.transactions.run(async (tx): Promise<MemberView> => {
      const actor = await this.beginChange(tenant, tx, null, input.role);
      if (!user || user.status !== 'active') throw userNotFound();
      const scope = scopeOf(actor);

      if (await this.memberships.findMember(scope, user.id, tx)) throw alreadyMember();
      let created: MembershipRecord;
      try {
        created = await this.memberships.add(scope, { userId: user.id, role: input.role }, tx);
      } catch (error) {
        if (isUniqueConstraintViolation(error)) throw alreadyMember();
        throw error;
      }

      await this.record(
        actor,
        created,
        { action: 'membership.added', metadata: { userId: user.id, role: input.role } },
        tx,
      );
      if (input.role === 'owner')
        await this.record(
          actor,
          created,
          { action: 'organization.owner_granted', metadata: { userId: user.id } },
          tx,
        );
      return { membership: created, user };
    });
  }

  async changeRole(tenant: TenantContext, userId: string, role: OrganizationRole): Promise<MemberView> {
    const membership = await this.transactions.run(async (tx) => {
      // Authorization depends on the target's CURRENT role, which is only trustworthy once the owners are locked.
      const scope = scopeOf(tenant);
      const owners = await this.memberships.lockOwners(scope, tx);
      const target = await this.memberships.findMember(scope, userId, tx);
      if (!target) throw memberNotFound();
      const actor = await this.authorizeChange(tenant, tx, target.role, role);
      if (target.role === role) return target; // nothing changes, nothing is audited

      if (target.role === 'owner' && leavesNoOwner(owners, userId)) throw lastOwner();
      const updated = await this.memberships.setRole(scope, userId, role, tx);

      await this.record(
        actor,
        updated,
        { action: 'membership.role_changed', metadata: { userId, previousRole: target.role, role } },
        tx,
      );
      if (role === 'owner')
        await this.record(actor, updated, { action: 'organization.owner_granted', metadata: { userId } }, tx);
      if (target.role === 'owner')
        await this.record(actor, updated, { action: 'organization.owner_revoked', metadata: { userId } }, tx);
      return updated;
    });
    return this.view(membership);
  }

  /**
   * Removes a member. A member may always remove THEMSELVES (leave) without `member.manage`, unless they are the last owner.
   */
  async remove(tenant: TenantContext, userId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const scope = scopeOf(tenant);
      const owners = await this.memberships.lockOwners(scope, tx); // L1
      const target = await this.memberships.lockMember(scope, userId, tx); // L3, exclusive (ADR-0011 decision 9)
      if (!target) throw memberNotFound();
      const self = userId === tenant.userId;
      const actor = self
        ? await this.tenants.resolve(tenant, tenant.organizationId, tx) // leaving needs membership, nothing more...
        : await this.authorizeChange(tenant, tx, target.role, null);
      // ...except that an owner who leaves, or removes an owner, is changing ownership.
      if (target.role === 'owner') this.authorization.authorize(actor, 'member.manage_owners');

      if (target.role === 'owner' && leavesNoOwner(owners, userId)) throw lastOwner();

      // Whatever depends on this membership (project memberships) is removed by its owner, inside this transaction and BEFORE the row
      // goes, because the foreign keys are RESTRICT. A participant failure propagates and rolls the whole removal back.
      const removal = {
        organizationId: tenant.organizationId,
        userId,
        membershipId: target.id,
        actorUserId: actor.userId,
      };
      for (const participant of this.lifecycle.participants())
        await participant.onMembershipRemoved(removal, tx);

      try {
        await this.memberships.remove(scope, userId, tx);
      } catch (error) {
        // Dependents remain although no participant removed them: fail closed, never orphan a row.
        if (isForeignKeyViolation(error)) throw membershipInUse();
        throw error;
      }

      await this.record(
        actor,
        target,
        { action: 'membership.removed', metadata: { userId, role: target.role, self } },
        tx,
      );
      if (target.role === 'owner')
        await this.record(actor, target, { action: 'organization.owner_revoked', metadata: { userId } }, tx);
    });
  }

  /** Locks the owners, then authorizes a change whose target is known only by role (adding: no current role yet). */
  private async beginChange(
    tenant: TenantContext,
    tx: DatabaseClient,
    current: OrganizationRole | null,
    next: OrganizationRole | null,
  ): Promise<TenantContext> {
    await this.memberships.lockOwners(scopeOf(tenant), tx);
    return this.authorizeChange(tenant, tx, current, next);
  }

  private async authorizeChange(
    tenant: TenantContext,
    tx: DatabaseClient,
    current: OrganizationRole | null,
    next: OrganizationRole | null,
  ): Promise<TenantContext> {
    const actor = await this.tenants.resolve(tenant, tenant.organizationId, tx);
    this.authorization.authorize(actor, ...permissionsToChangeMembership(current, next));
    return actor;
  }

  private record(
    actor: TenantContext,
    membership: MembershipRecord,
    event: MembershipEventBody,
    tx: DatabaseClient,
  ): Promise<void> {
    return this.audit.record(
      {
        ...event,
        resourceType: 'membership',
        result: 'success',
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        resourceId: membership.id,
      },
      tx,
    );
  }

  private async view(membership: MembershipRecord): Promise<MemberView> {
    const [member] = await this.withUsers([membership]);
    if (!member) throw memberNotFound();
    return member;
  }

  private async withUsers(memberships: MembershipRecord[]): Promise<MemberView[]> {
    const users = new Map(
      (await this.users.findByIds(memberships.map((membership) => membership.userId))).map((user) => [
        user.id,
        user,
      ]),
    );
    // A membership always has a user (foreign key); the filter only keeps the types honest.
    return memberships.flatMap((membership) => {
      const user = users.get(membership.userId);
      return user ? [{ membership, user }] : [];
    });
  }
}
