import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DatabaseClient, PrismaService } from '../../database';
import { OrganizationScope } from '../../organizations';
import { ProjectScope } from '../domain/project-context';
import { PrismaProjectMemberRepository } from './prisma-project-member.repository';
import { PrismaProjectRepository } from './prisma-project.repository';

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

describe('project repositories fail closed', () => {
  const { client, touched } = untouchableDatabase();
  const projects = new PrismaProjectRepository(client as unknown as PrismaService);
  const members = new PrismaProjectMemberRepository(client as unknown as PrismaService);
  const [org, proj, user] = [randomUUID(), randomUUID(), randomUUID()];
  const page = { limit: 10, offset: 0 };
  const visibility = { kind: 'organization', userId: user } as const;

  const badOrganizationScopes: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['a bare organization id', org],
    ['a look-alike object', { organizationId: org }],
    ['an empty organization id', OrganizationScope.of('')],
    ['a malformed organization id', OrganizationScope.of("x' OR '1'='1")],
  ];
  const badProjectScopes: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['a bare project id', proj],
    ['a look-alike object', { organizationId: org, projectId: proj }],
    ['an organization scope in its place', OrganizationScope.of(org)],
    ['an empty project id', ProjectScope.of(org, '')],
    ['a malformed organization id', ProjectScope.of('nope', proj)],
  ];

  // Every method that takes an organization scope / a project scope, with a representative call. A new scoped method must be added here.
  const memberScoped: [string, (scope: never) => Promise<unknown>][] = [
    ['ProjectMemberRepository.list', (s) => members.list(s, page, client)],
    ['ProjectMemberRepository.find', (s) => members.find(s, user, client)],
    ['ProjectMemberRepository.add', (s) => members.add(s, { userId: user, role: 'project_viewer' }, client)],
    ['ProjectMemberRepository.setRole', (s) => members.setRole(s, user, 'project_admin', client)],
    ['ProjectMemberRepository.remove', (s) => members.remove(s, user, client)],
  ];
  const organizationScoped: [string, (scope: never) => Promise<unknown>][] = [
    [
      'ProjectRepository.createWithCreator',
      (s) => projects.createWithCreator(s, { name: 'n', slug: 'sl', description: null }, user, client),
    ],
    ['ProjectRepository.list', (s) => projects.list(s, visibility, 'active', page, client)],
  ];
  const projectScoped: [string, (scope: never) => Promise<unknown>][] = [
    ['ProjectRepository.lock', (s) => projects.lock(s, client)],
    ['ProjectRepository.update', (s) => projects.update(s, { name: 'x' }, client)],
    ['ProjectRepository.setArchived', (s) => projects.setArchived(s, new Date(), client)],
  ];

  for (const [name, call] of organizationScoped)
    for (const [label, scope] of badOrganizationScopes)
      it(`${name} rejects ${label} without issuing a query`, async () => {
        await expect(call(scope as never)).rejects.toThrow(/OrganizationScope/);
        expect(touched).toEqual([]);
      });

  for (const [name, call] of [...projectScoped, ...memberScoped])
    for (const [label, scope] of badProjectScopes)
      it(`${name} rejects ${label} without issuing a query`, async () => {
        await expect(call(scope as never)).rejects.toThrow(/ProjectScope/);
        expect(touched).toEqual([]);
      });

  it('refuses a listing without a valid visibility, without issuing a query', async () => {
    const scope = OrganizationScope.of(org);
    for (const bad of [
      undefined,
      null,
      {},
      { kind: 'everything', userId: user },
      { kind: 'explicit', userId: 'not-a-uuid' },
      { kind: 'organization' },
    ])
      await expect(projects.list(scope, bad as never, 'active', page, client)).rejects.toThrow(
        /ProjectVisibility/,
      );
    expect(touched).toEqual([]);
  });

  it('answers the id-only lookup with nothing, and no query, for an empty or malformed list or id', async () => {
    expect(await projects.findInOrganizations([], proj, client)).toBeNull();
    expect(await projects.findInOrganizations([org], 'not-a-uuid', client)).toBeNull();
    expect(await projects.findInOrganizations([org, 'drop table'], proj, client)).toBeNull();
    expect(touched).toEqual([]);
  });

  it('covers every scoped method of both repositories; only the named resolution and cleanup methods take no scope', () => {
    const methodsOf = (repository: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter((name) => name !== 'constructor');
    // RESOLUTION methods are how a context is earned; CLEANUP is called by the organizations module with the ids of the membership it removes.
    const unscoped = ['findInOrganizations', 'findRoleOn', 'deleteAllOfUserInOrganization'];
    const covered = [...organizationScoped, ...projectScoped, ...memberScoped].map(
      ([name]) => name.split('.')[1],
    );
    expect(
      [...methodsOf(projects), ...methodsOf(members)].filter((name) => !unscoped.includes(name)).sort(),
    ).toEqual([...covered].sort());
  });
});
