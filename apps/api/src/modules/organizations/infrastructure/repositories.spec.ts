import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient, PrismaService } from '../../database';
import { OrganizationScope } from '../domain/tenant';
import { PrismaMembershipRepository } from './prisma-membership.repository';
import { PrismaOrganizationRepository } from './prisma-organization.repository';

/**
 * A database client that records every touch: ANY property access (a model, `$queryRaw`, `$transaction`) counts as issuing a query. The
 * repositories must refuse a bad scope before reaching it.
 */
function untouchableDatabase() {
  const touched: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`the database was touched (${String(property)})`);
      },
    },
  ) as unknown as DatabaseClient;
  return { client, touched };
}

const invalidScopes: [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['a bare organization id', randomUUID()],
  ['a look-alike object', { organizationId: randomUUID() }],
  ['an empty organization id', OrganizationScope.of('')],
  ['a malformed organization id', OrganizationScope.of("x' OR '1'='1")],
];

describe('organization-scoped repository methods fail closed', () => {
  const { client, touched } = untouchableDatabase();
  const organizations = new PrismaOrganizationRepository(client as unknown as PrismaService);
  const memberships = new PrismaMembershipRepository(client as unknown as PrismaService);
  const user = randomUUID();
  const page = { limit: 10, offset: 0 };

  // Every method that takes a scope, with a representative call. A new scoped method must be added here.
  const calls: [string, (scope: never) => Promise<unknown>][] = [
    ['OrganizationRepository.findById', (scope) => organizations.findById(scope, client)],
    ['OrganizationRepository.updateName', (scope) => organizations.updateName(scope, 'x', client)],
    ['MembershipRepository.list', (scope) => memberships.list(scope, page, client)],
    ['MembershipRepository.findMember', (scope) => memberships.findMember(scope, user, client)],
    ['MembershipRepository.lockOwners', (scope) => memberships.lockOwners(scope, client)],
    ['MembershipRepository.add', (scope) => memberships.add(scope, { userId: user, role: 'member' }, client)],
    ['MembershipRepository.setRole', (scope) => memberships.setRole(scope, user, 'admin', client)],
    ['MembershipRepository.remove', (scope) => memberships.remove(scope, user, client)],
  ];

  for (const [name, call] of calls)
    for (const [label, scope] of invalidScopes)
      it(`${name} rejects ${label} without issuing a query`, async () => {
        await expect(call(scope as never)).rejects.toThrow(/OrganizationScope/);
        expect(touched).toEqual([]);
      });

  it('covers every scoped method of both repositories', () => {
    const scoped = (repository: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter(
        (name) =>
          name !== 'constructor' && (repository as Record<string, { length: number }>)[name]!.length >= 1,
      );
    const keyedByUser = ['find', 'listOrganizationsOf', 'organizationIdsOf', 'createWithOwner'];
    const expected = [...scoped(organizations), ...scoped(memberships)]
      .filter((name) => !keyedByUser.includes(name))
      .sort();
    const covered = calls.map(([name]) => name.split('.')[1]!).sort();
    expect(covered).toEqual(expected);
  });
});
