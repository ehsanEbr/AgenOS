import { Injectable } from '@nestjs/common';
import type { Membership, Organization } from '@prisma/client';
import { type DatabaseClient, PrismaService } from '../../database';
import type { OrganizationRepository } from '../application/ports';
import type { MembershipRecord, OrganizationRecord } from '../domain/organization';
import { type OrganizationScope, requireScope } from '../domain/tenant';

export function toOrganizationRecord(row: Organization): OrganizationRecord {
  return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function toMembershipRecord(row: Membership): MembershipRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithOwner(
    name: string,
    ownerUserId: string,
    db: DatabaseClient,
  ): Promise<{ organization: OrganizationRecord; membership: MembershipRecord }> {
    const row = await db.organization.create({
      data: { name, memberships: { create: { userId: ownerUserId, role: 'owner' } } },
      include: { memberships: true },
    });
    const membership = row.memberships[0];
    if (!membership) throw new Error('The owner membership was not created with the organization');
    return { organization: toOrganizationRecord(row), membership: toMembershipRecord(membership) };
  }

  async findById(
    scope: OrganizationScope,
    db: DatabaseClient = this.prisma,
  ): Promise<OrganizationRecord | null> {
    const { organizationId } = requireScope(scope);
    const row = await db.organization.findUnique({ where: { id: organizationId } });
    return row && toOrganizationRecord(row);
  }

  async updateName(scope: OrganizationScope, name: string, db: DatabaseClient): Promise<OrganizationRecord> {
    const { organizationId } = requireScope(scope);
    return toOrganizationRecord(
      await db.organization.update({ where: { id: organizationId }, data: { name } }),
    );
  }
}
