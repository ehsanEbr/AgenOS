import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { OrganizationRole } from '@agentos/contracts';
import { AppError } from '../../../common/app-error';
import { InMemoryMemberships } from '../../../../test/support/organization-fakes';
import { InMemoryProjectMembers, InMemoryProjects } from '../../../../test/support/project-fakes';
import { AuthorizationService, MembershipDirectory, TenantAccess } from '../../organizations';
import { ProjectAccess } from '../application/project-access';
import { OrganizationContext, ProjectContext } from '../domain/project-context';
import { RequireOrganizationPermission, RequireProjectPermission } from './decorators';
import type { HttpRequest } from './http';
import { ProjectAccessGuard } from './project-access.guard';

class Routes {
  @RequireProjectPermission('project.update')
  update() {}
  @RequireOrganizationPermission('project.list', 'query')
  list() {}
  @RequireOrganizationPermission('project.create', 'body')
  create() {}
  undeclared() {}
}

function contextOf(handler: () => void, request: Partial<HttpRequest>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function build() {
  const orgMemberships = new InMemoryMemberships();
  const members = new InMemoryProjectMembers();
  const projects = new InMemoryProjects(members);
  const access = new ProjectAccess(
    new TenantAccess(orgMemberships),
    new AuthorizationService(),
    new MembershipDirectory(orgMemberships),
    projects,
    members,
  );
  const guard = new ProjectAccessGuard(new Reflector(), access);
  const organization = randomUUID();
  const project = projects.seed(organization, 'apollo');
  const join = (role: OrganizationRole) => {
    const userId = randomUUID();
    orgMemberships.insert(organization, { userId, role });
    return userId;
  };
  const request = (userId: string | null, extra: Partial<HttpRequest> = {}): HttpRequest => ({
    params: {},
    ...(userId ? { auth: { principal: { userId, sessionId: randomUUID() } } } : {}),
    ...extra,
  });
  return { guard, organization, project, members, join, request };
}

const answer = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? `${error.kind}:${error.code}` : `error:${(error as Error).message}`;
  }
};

describe('ProjectAccessGuard on a project-addressed route', () => {
  it('hands the handler a genuine ProjectContext for a caller with access and the permission', async () => {
    const { guard, project, join, request } = build();
    const owner = join('owner');
    const req = request(owner, { params: { projectId: project.id } });
    await expect(guard.canActivate(contextOf(Routes.prototype.update, req))).resolves.toBe(true);
    expect(req.projectContext).toBeInstanceOf(ProjectContext);
    expect(req.projectContext?.project.id).toBe(project.id);
  });

  it('answers 403 for a caller who can see the project but may not update it, and sets no context', async () => {
    const { guard, project, members, join, request } = build();
    const viewer = join('viewer');
    members.insert(project, viewer, 'project_viewer');
    const req = request(viewer, { params: { projectId: project.id } });
    expect(await answer(guard.canActivate(contextOf(Routes.prototype.update, req)))).toBe(
      'forbidden:forbidden',
    );
    expect(req.projectContext).toBeUndefined();
  });

  it('answers the same 404 for a non-member, a member without a project role and a malformed or unknown id', async () => {
    const { guard, project, join, request } = build();
    const member = join('member');
    for (const [user, id] of [
      [randomUUID(), project.id], // not in the organization at all
      [member, project.id], // in the organization, no project membership
      [member, 'not-a-uuid'],
      [member, randomUUID()],
      [member, ''],
    ] as const)
      expect(
        await answer(
          guard.canActivate(contextOf(Routes.prototype.update, request(user, { params: { projectId: id } }))),
        ),
      ).toBe('not_found:project_not_found');
  });
});

describe('ProjectAccessGuard on an organization-addressed route', () => {
  it('resolves the selector from the query or the body and hands the handler an OrganizationContext', async () => {
    const { guard, organization, join, request } = build();
    const member = join('member');
    const fromQuery = request(member, { query: { organizationId: organization } });
    await expect(guard.canActivate(contextOf(Routes.prototype.list, fromQuery))).resolves.toBe(true);
    expect(fromQuery.organizationContext).toBeInstanceOf(OrganizationContext);
    const fromBody = request(member, { body: { organizationId: organization } });
    await expect(guard.canActivate(contextOf(Routes.prototype.create, fromBody))).resolves.toBe(true);
    expect(fromBody.organizationContext?.tenant.organizationId).toBe(organization);
  });

  it('answers 400 when the selector is absent or not a single string, and 404 when it is not the caller organization', async () => {
    const { guard, organization, join, request } = build();
    const member = join('member');
    for (const query of [
      {},
      { organizationId: '' },
      { organizationId: [organization, organization] },
      { organizationId: 5 },
    ])
      expect(
        await answer(guard.canActivate(contextOf(Routes.prototype.list, request(member, { query })))),
      ).toBe('validation:validation_error');
    for (const id of [randomUUID(), 'not-a-uuid', "' OR 1=1 --"])
      expect(
        await answer(
          guard.canActivate(
            contextOf(Routes.prototype.list, request(member, { query: { organizationId: id } })),
          ),
        ),
      ).toBe('not_found:organization_not_found');
  });

  it('answers 403 for a viewer creating a project, and 404 (not 403) for a stranger', async () => {
    const { guard, organization, join, request } = build();
    const viewer = join('viewer');
    expect(
      await answer(
        guard.canActivate(
          contextOf(Routes.prototype.create, request(viewer, { body: { organizationId: organization } })),
        ),
      ),
    ).toBe('forbidden:forbidden');
    expect(
      await answer(
        guard.canActivate(
          contextOf(
            Routes.prototype.create,
            request(randomUUID(), { body: { organizationId: organization } }),
          ),
        ),
      ),
    ).toBe('not_found:organization_not_found');
  });
});

describe('ProjectAccessGuard fails closed', () => {
  it('refuses a route that declares nothing, and a request that was not authenticated first', async () => {
    const { guard, project, join, request } = build();
    const owner = join('owner');
    expect(
      await answer(
        guard.canActivate(
          contextOf(Routes.prototype.undeclared, request(owner, { params: { projectId: project.id } })),
        ),
      ),
    ).toMatch(/does not declare its access/);
    expect(
      await answer(
        guard.canActivate(
          contextOf(Routes.prototype.update, request(null, { params: { projectId: project.id } })),
        ),
      ),
    ).toMatch(/before authentication/);
  });
});
