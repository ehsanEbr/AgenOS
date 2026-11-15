import { Injectable } from '@nestjs/common';
import type { OrganizationRole } from '@agentos/contracts';
import { type DatabaseClient, PrismaService } from '../../database';
import type { MembershipRepository, NewMembership, PageOf, PageRequest } from '../application/ports';
import type { MembershipOfUser, MembershipRecord } from '../domain/organization';
import { type OrganizationScope, requireScope } from '../domain/tenant';
import { toMembershipRecord, toOrganizationRecord } from './prisma-organization.repository';

/** Stable page order: oldest first, the id breaks ties, so paging never repeats or skips a row. */
const ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

@Injectable()
export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- keyed by user: how a TenantContext is earned, and "my organizations" -------------------------------------------------------

  async find(
    organizationId: string,
    userId: string,
    db: DatabaseClient = this.prisma,
  ): Promise<MembershipRecord | null> {
    const row = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return row && toMembershipRecord(row);
  }

  async listOrganizationsOf(
    userId: string,
    page: PageRequest,
    db: DatabaseClient = this.prisma,
  ): Promise<PageOf<MembershipOfUser>> {
    const [rows, total] = await Promise.all([
      db.membership.findMany({
        where: { userId },
        include: { organization: true },
        orderBy: [...ORDER],
        take: page.limit,
        skip: page.offset,
      }),
      db.membership.count({ where: { userId } }),
    ]);
    return {
      total,
      items: rows.map((row) => ({ organization: toOrganizationRecord(row.organization), role: row.role })),
    };
  }

  async organizationIdsOf(userId: string, db: DatabaseClient = this.prisma): Promise<string[]> {
    const rows = await db.membership.findMany({ where: { userId }, select: { organizationId: true } });
    return rows.map((row) => row.organizationId);
  }

  // --- scoped: every statement below is filtered by the organization of the scope --------------------------------------------------

  async list(
    scope: OrganizationScope,
    page: PageRequest,
    db: DatabaseClient = this.prisma,
  ): Promise<PageOf<MembershipRecord>> {
    const { organizationId } = requireScope(scope);
    const [rows, total] = await Promise.all([
      db.membership.findMany({
        where: { organizationId },
        orderBy: [...ORDER],
        take: page.limit,
        skip: page.offset,
      }),
      db.membership.count({ where: { organizationId } }),
    ]);
    return { total, items: rows.map(toMembershipRecord) };
  }

  async findMember(
    scope: OrganizationScope,
    userId: string,
    db: DatabaseClient = this.prisma,
  ): Promise<MembershipRecord | null> {
    const { organizationId } = requireScope(scope);
    const row = await db.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return row && toMembershipRecord(row);
  }

  async lockOwners(scope: OrganizationScope, db: DatabaseClient): Promise<string[]> {
    const { organizationId } = requireScope(scope);
    // Rows are locked in a fixed order (by id), so two transactions can never wait for each other in a cycle. The lock is held until the
    // surrounding transaction ends. Names are schema-qualified because raw SQL does not use Prisma's schema mapping.
    await db.$queryRaw`
      SELECT id FROM identity.membership
       WHERE organization_id = ${organizationId}::uuid AND role = 'owner'::identity.organization_role
       ORDER BY id
         FOR UPDATE`;
    // A SEPARATE statement: it takes a fresh snapshot, so it sees what the transaction that held the lock before us committed (a lock
    // wait alone does not show rows that BECAME owners meanwhile).
    const owners = await db.membership.findMany({
      where: { organizationId, role: 'owner' },
      select: { userId: true },
    });
    return owners.map((owner) => owner.userId);
  }

  async add(
    scope: OrganizationScope,
    membership: NewMembership,
    db: DatabaseClient,
  ): Promise<MembershipRecord> {
    const { organizationId } = requireScope(scope);
    return toMembershipRecord(
      await db.membership.create({
        data: { organizationId, userId: membership.userId, role: membership.role },
      }),
    );
  }

  async setRole(
    scope: OrganizationScope,
    userId: string,
    role: OrganizationRole,
    db: DatabaseClient,
  ): Promise<MembershipRecord> {
    const { organizationId } = requireScope(scope);
    return toMembershipRecord(
      await db.membership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role },
      }),
    );
  }

  async remove(scope: OrganizationScope, userId: string, db: DatabaseClient): Promise<boolean> {
    const { organizationId } = requireScope(scope);
    const { count } = await db.membership.deleteMany({ where: { organizationId, userId } });
    return count > 0;
  }
}
