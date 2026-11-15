import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { OrganizationRole } from '@agentos/contracts';
import type {
  MembershipRepository,
  NewMembership,
  OrganizationRepository,
  PageOf,
  PageRequest,
} from '../../src/modules/organizations/application/ports';
import type {
  MembershipOfUser,
  MembershipRecord,
  OrganizationRecord,
} from '../../src/modules/organizations/domain/organization';
import { type OrganizationScope, requireScope } from '../../src/modules/organizations/domain/tenant';
import type { UserSummary } from '../../src/modules/identity';

/*
 * In-memory stand-ins for the organizations ports, so the application services can be tested without PostgreSQL. They honor the same
 * contract as the real repositories, scope included: a missing or forged scope throws. What they CANNOT show is concurrency (locking);
 * that is tested against the real database in organizations.int.spec.ts.
 */

export class InMemoryOrganizations implements OrganizationRepository {
  readonly organizations = new Map<string, OrganizationRecord>();

  constructor(private readonly memberships: InMemoryMemberships) {}

  createWithOwner(name: string, ownerUserId: string) {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const organization: OrganizationRecord = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    this.organizations.set(organization.id, organization);
    const membership = this.memberships.insert(organization.id, { userId: ownerUserId, role: 'owner' });
    return Promise.resolve({ organization, membership });
  }
  findById(scope: OrganizationScope) {
    return Promise.resolve(this.organizations.get(requireScope(scope).organizationId) ?? null);
  }
  updateName(scope: OrganizationScope, name: string) {
    const { organizationId } = requireScope(scope);
    const current = this.organizations.get(organizationId);
    if (!current) return Promise.reject(new Error('no such organization'));
    const updated = { ...current, name, updatedAt: new Date('2026-03-02T12:00:00.000Z') };
    this.organizations.set(organizationId, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryMemberships implements MembershipRepository {
  readonly rows: MembershipRecord[] = [];
  /** Counts calls to lockOwners, to prove every change takes the lock. */
  lockCalls = 0;
  organizations?: InMemoryOrganizations;

  insert(organizationId: string, membership: NewMembership): MembershipRecord {
    const record: MembershipRecord = {
      id: randomUUID(),
      organizationId,
      userId: membership.userId,
      role: membership.role,
      createdAt: new Date(`2026-03-01T12:00:${String(this.rows.length % 60).padStart(2, '0')}.000Z`),
    };
    this.rows.push(record);
    return record;
  }

  rolesIn(organizationId: string): Record<string, OrganizationRole> {
    return Object.fromEntries(
      this.rows.filter((row) => row.organizationId === organizationId).map((row) => [row.userId, row.role]),
    );
  }

  find(organizationId: string, userId: string) {
    return Promise.resolve(
      this.rows.find((row) => row.organizationId === organizationId && row.userId === userId) ?? null,
    );
  }
  listOrganizationsOf(userId: string, page: PageRequest): Promise<PageOf<MembershipOfUser>> {
    const mine = this.rows.filter((row) => row.userId === userId);
    const items = mine.slice(page.offset, page.offset + page.limit).flatMap((row) => {
      const organization = this.organizations?.organizations.get(row.organizationId);
      return organization ? [{ organization, role: row.role }] : [];
    });
    return Promise.resolve({ items, total: mine.length });
  }
  organizationIdsOf(userId: string) {
    return Promise.resolve(this.rows.filter((row) => row.userId === userId).map((row) => row.organizationId));
  }

  list(scope: OrganizationScope, page: PageRequest): Promise<PageOf<MembershipRecord>> {
    const { organizationId } = requireScope(scope);
    const all = this.rows.filter((row) => row.organizationId === organizationId);
    return Promise.resolve({ items: all.slice(page.offset, page.offset + page.limit), total: all.length });
  }
  findMember(scope: OrganizationScope, userId: string) {
    const { organizationId } = requireScope(scope);
    return this.find(organizationId, userId);
  }
  lockMember(scope: OrganizationScope, userId: string) {
    const { organizationId } = requireScope(scope);
    this.lockMemberCalls += 1;
    return this.find(organizationId, userId);
  }
  /** The organization memberships held with `hold`, in order (the project side holds at most one per operation). */
  readonly held: { organizationId: string; userId: string }[] = [];
  hold(organizationId: string, userId: string) {
    this.held.push({ organizationId, userId });
    return Promise.resolve(
      this.rows.some((row) => row.organizationId === organizationId && row.userId === userId),
    );
  }
  lockMemberCalls = 0;
  /** Set to make `remove` fail like the database does when a dependent row still references the membership. */
  failRemovalWith?: unknown;
  lockOwners(scope: OrganizationScope) {
    const { organizationId } = requireScope(scope);
    this.lockCalls += 1;
    return Promise.resolve(
      this.rows
        .filter((row) => row.organizationId === organizationId && row.role === 'owner')
        .map((row) => row.userId),
    );
  }
  add(scope: OrganizationScope, membership: NewMembership) {
    const { organizationId } = requireScope(scope);
    return Promise.resolve(this.insert(organizationId, membership));
  }
  setRole(scope: OrganizationScope, userId: string, role: OrganizationRole) {
    const { organizationId } = requireScope(scope);
    const index = this.rows.findIndex(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );
    const current = this.rows[index];
    if (!current) return Promise.reject(new Error('no such membership'));
    const updated = { ...current, role };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
  remove(scope: OrganizationScope, userId: string) {
    const { organizationId } = requireScope(scope);
    if (this.failRemovalWith) return Promise.reject(this.failRemovalWith);
    const index = this.rows.findIndex(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );
    if (index === -1) return Promise.resolve(false);
    this.rows.splice(index, 1);
    return Promise.resolve(true);
  }
}

/** The part of Identity's `UserDirectory` the organizations services use. */
export class FakeUserDirectory {
  readonly users: UserSummary[] = [];

  add(name: string, status: UserSummary['status'] = 'active'): UserSummary {
    const user: UserSummary = { id: randomUUID(), email: `${name}@example.com`, displayName: name, status };
    this.users.push(user);
    return user;
  }
  findByEmail(email: string) {
    return Promise.resolve(this.users.find((user) => user.email === email) ?? null);
  }
  findByIds(ids: readonly string[]) {
    return Promise.resolve(this.users.filter((user) => ids.includes(user.id)));
  }
  findById(id: string) {
    return Promise.resolve(this.users.find((user) => user.id === id) ?? null);
  }
}

/** What Prisma raises when a foreign key blocks a delete (P2003). */
export const foreignKeyViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
    code: 'P2003',
    clientVersion: 'test',
  });
