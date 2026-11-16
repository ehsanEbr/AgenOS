import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@agentos/contracts';
import { IS_PUBLIC_KEY } from '../src/modules/identity/presentation/decorators';
import { REQUIRED_PERMISSION_KEY } from '../src/modules/organizations/presentation/decorators';
import { OrganizationAccessGuard } from '../src/modules/organizations/presentation/organization-access.guard';
import { PROJECT_ACCESS_KEY, type ProjectRouteAccess } from '../src/modules/projects/presentation/decorators';
import { ProjectAccessGuard } from '../src/modules/projects/presentation/project-access.guard';
import { createTestApp } from './support/create-test-app';

/*
 * Deny by default, checked on the REAL composition (ADR-0010, decision 4.4c): this test enumerates EVERY controller route and fails
 * unless each one is public, gated by a declared permission, or on the short, explicit list of account-scoped routes below. A new route
 * therefore cannot slip in unclassified: whoever adds one has to add it here, which makes the access decision visible in review.
 *
 * What the three classes mean:
 *   public           @Public(): no session needed (the health probes and the sign-in/registration pair, pinned in identity.e2e.spec.ts)
 *   permission       the route reaches its tenant through a guard and declares the permission it needs:
 *                      - under `:organizationId`: OrganizationAccessGuard resolves the caller's membership (404 for a non-member) and checks
 *                        the permission declared with @RequirePermission (403 for a member without it)
 *                      - under `/projects` (ADR-0011): ProjectAccessGuard finds the project among the caller's organizations, or validates
 *                        an organization selector, and checks the permission declared with @RequireProjectPermission /
 *                        @RequireOrganizationPermission
 *   account-scoped   authenticated only; acts on the caller's own account and names no organization, so there is nothing to resolve
 */

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

interface RouteInfo {
  route: string;
  public: boolean;
  permission: string | undefined;
  guardedByOrganizationAccess: boolean;
  /** How a `/projects` route reaches its tenant, when it declares it. */
  projectAccess: ProjectRouteAccess | undefined;
  guardedByProjectAccess: boolean;
}

function routesOf(app: INestApplication): RouteInfo[] {
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values())
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype;
      if (!type || !wrapper.instance) continue;
      const prefix = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      const prototype = Object.getPrototypeOf(wrapper.instance) as Record<
        string,
        (...args: never[]) => unknown
      >;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue; // not a route handler
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, type) as unknown[] | undefined) ?? []),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
        ];
        const projectAccess = reflector.getAllAndOverride<ProjectRouteAccess | undefined>(
          PROJECT_ACCESS_KEY,
          [handler, type],
        );
        routes.push({
          route: `${VERBS[method]} /${[prefix, path].filter((part) => part && part !== '/').join('/')}`,
          public: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [handler, type]) === true,
          permission:
            reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [handler, type]) ??
            projectAccess?.permission,
          guardedByOrganizationAccess: guards.includes(OrganizationAccessGuard),
          projectAccess,
          guardedByProjectAccess: guards.includes(ProjectAccessGuard),
        });
      }
    }
  return routes;
}

/** Authenticated routes that name no organization. Adding one is a deliberate, reviewed change. */
const ACCOUNT_SCOPED = [
  'GET /me',
  'POST /auth/logout',
  'POST /auth/logout-all',
  'POST /me/password',
  'GET /organizations',
  'POST /organizations',
];

/** Every permission-gated route and the permission it declares. */
const PERMISSION_GATED: Record<string, string> = {
  'GET /organizations/:organizationId': 'organization.read',
  'PATCH /organizations/:organizationId': 'organization.update',
  'GET /organizations/:organizationId/members': 'member.read',
  'POST /organizations/:organizationId/members': 'member.manage',
  'PATCH /organizations/:organizationId/members/:userId': 'member.manage',
  // Declared as member.read because LEAVING needs only membership; MembershipService requires member.manage (and, for an owner,
  // member.manage_owners) to remove somebody else.
  'DELETE /organizations/:organizationId/members/:userId': 'member.read',
  // projects (ADR-0011): addressed by a project id, or by an organization selector in the query/body
  'GET /projects': 'project.list',
  'POST /projects': 'project.create',
  'GET /projects/:projectId': 'project.read',
  'PATCH /projects/:projectId': 'project.update',
  'POST /projects/:projectId/archive': 'project.archive',
  'POST /projects/:projectId/restore': 'project.archive',
  'GET /projects/:projectId/members': 'project.read',
  'POST /projects/:projectId/members': 'project.member.manage',
  'PATCH /projects/:projectId/members/:userId': 'project.member.manage',
  'DELETE /projects/:projectId/members/:userId': 'project.member.manage',
};

/** How each `/projects` route reaches its tenant: through the project id, or through an organization selector and where it is. */
const PROJECT_ROUTE_KIND: Record<string, string> = {
  'GET /projects': 'organization:query',
  'POST /projects': 'organization:body',
  'GET /projects/:projectId': 'project',
  'PATCH /projects/:projectId': 'project',
  'POST /projects/:projectId/archive': 'project',
  'POST /projects/:projectId/restore': 'project',
  'GET /projects/:projectId/members': 'project',
  'POST /projects/:projectId/members': 'project',
  'PATCH /projects/:projectId/members/:userId': 'project',
  'DELETE /projects/:projectId/members/:userId': 'project',
};

describe('every route declares how it is protected', () => {
  let app: INestApplication;
  let routes: RouteInfo[];
  beforeAll(async () => {
    ({ app } = await createTestApp());
    routes = routesOf(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('classifies every route as public, permission-gated or account-scoped: nothing is left unclassified', () => {
    const unclassified = routes.filter(
      (info) => !info.public && !info.permission && !ACCOUNT_SCOPED.includes(info.route),
    );
    expect(unclassified.map((info) => info.route)).toEqual([]);
  });

  it('pins the permission of each gated route and the account-scoped list exactly', () => {
    const gated = Object.fromEntries(
      routes.filter((info) => info.permission).map((info) => [info.route, info.permission]),
    );
    expect(gated).toEqual(PERMISSION_GATED);
    expect(
      routes
        .filter((info) => ACCOUNT_SCOPED.includes(info.route))
        .map((info) => info.route)
        .sort(),
    ).toEqual([...ACCOUNT_SCOPED].sort());
  });

  it('puts every route under an :organizationId behind the organizations tenant guard and a declared permission', () => {
    for (const info of routes) {
      const namesOrganization = info.route.includes(':organizationId');
      expect(info.guardedByOrganizationAccess, `${info.route} guard`).toBe(namesOrganization);
      if (namesOrganization) expect(Boolean(info.permission), `${info.route} permission`).toBe(true);
    }
  });

  it('puts every /projects route behind the project guard with its access declared, and pins how each reaches its tenant', () => {
    const projectRoutes = routes.filter((info) => /^[A-Z]+ \/projects(\/|$)/.test(info.route));
    expect(projectRoutes.map((info) => info.route).sort()).toEqual(Object.keys(PROJECT_ROUTE_KIND).sort());
    for (const info of projectRoutes) {
      expect(info.guardedByProjectAccess, `${info.route} guard`).toBe(true);
      expect(info.guardedByOrganizationAccess, `${info.route} is not under the organizations guard`).toBe(
        false,
      );
      const access = info.projectAccess;
      expect(access, `${info.route} access`).toBeDefined();
      const kind = access?.kind === 'organization' ? `organization:${access.from}` : access?.kind;
      expect(kind, info.route).toBe(PROJECT_ROUTE_KIND[info.route]);
    }
    // and nothing outside /projects uses the project guard
    expect(routes.filter((info) => info.guardedByProjectAccess).length).toBe(projectRoutes.length);
  });

  it('never combines @Public() with a permission or a tenant guard', () => {
    for (const info of routes.filter((candidate) => candidate.public)) {
      expect(info.permission, info.route).toBeUndefined();
      expect(info.guardedByOrganizationAccess, info.route).toBe(false);
      expect(info.guardedByProjectAccess, info.route).toBe(false);
    }
  });

  it('only declares permissions that exist in the catalog', () => {
    for (const info of routes)
      if (info.permission) expect(Object.keys(PERMISSIONS)).toContain(info.permission);
  });
});
