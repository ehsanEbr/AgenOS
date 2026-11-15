import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/app-error';
import { FakeUserDirectory, InMemoryMemberships } from '../../../../test/support/organization-fakes';
import { AuthorizationService } from '../application/authorization.service';
import { TenantAccess } from '../application/tenant-access';
import { RequirePermission } from './decorators';
import type { HttpRequest } from './http';
import { OrganizationAccessGuard } from './organization-access.guard';

class Routes {
  @RequirePermission('member.manage')
  manage() {}
  @RequirePermission('organization.read')
  read() {}
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
  const memberships = new InMemoryMemberships();
  const guard = new OrganizationAccessGuard(
    new Reflector(),
    new TenantAccess(memberships),
    new AuthorizationService(),
  );
  const organizationId = randomUUID();
  const join = (role: 'owner' | 'admin' | 'member' | 'viewer') => {
    const user = new FakeUserDirectory().add(role);
    memberships.insert(organizationId, { userId: user.id, role });
    return user.id;
  };
  const requestOf = (userId: string | null, id: string): HttpRequest & { tenant?: unknown } => ({
    params: { organizationId: id },
    ...(userId ? { auth: { principal: { userId, sessionId: randomUUID() } } } : {}),
  });
  return { guard, organizationId, join, requestOf };
}

const expectAppError = async (promise: Promise<unknown>, kind: string, code: string) => {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ kind, code });
};

describe('OrganizationAccessGuard', () => {
  it('lets a member who holds the permission through and hands the handler the validated tenant', async () => {
    const { guard, organizationId, join, requestOf } = build();
    const userId = join('admin');
    const request = requestOf(userId, organizationId);
    await expect(guard.canActivate(contextOf(Routes.prototype.manage, request))).resolves.toBe(true);
    expect(request.tenant).toEqual({ organizationId, userId, role: 'admin' });
  });

  it('answers 403 for a member who lacks the permission, and sets no tenant', async () => {
    const { guard, organizationId, join, requestOf } = build();
    const request = requestOf(join('viewer'), organizationId);
    await expectAppError(
      guard.canActivate(contextOf(Routes.prototype.manage, request)),
      'forbidden',
      'forbidden',
    );
    expect(request.tenant).toBeUndefined();
    // ...while the same viewer may read.
    await expect(
      guard.canActivate(contextOf(Routes.prototype.read, requestOf(join('viewer'), organizationId))),
    ).resolves.toBe(true);
  });

  it('answers 404 for a non-member, for an unknown organization and for a malformed id: the same answer, before any permission check', async () => {
    const { guard, organizationId, join, requestOf } = build();
    join('owner');
    const stranger = randomUUID();
    for (const id of [organizationId, randomUUID(), 'not-a-uuid', '', "' OR 1=1 --"])
      await expectAppError(
        guard.canActivate(contextOf(Routes.prototype.manage, requestOf(stranger, id))),
        'not_found',
        'organization_not_found',
      );
  });

  it('fails closed: a route without a declared permission is an error, never served', async () => {
    const { guard, organizationId, join, requestOf } = build();
    const request = requestOf(join('owner'), organizationId);
    await expect(guard.canActivate(contextOf(Routes.prototype.undeclared, request))).rejects.toThrow(
      /@RequirePermission/,
    );
    expect(request.tenant).toBeUndefined();
  });

  it('fails closed when authentication did not run before it', async () => {
    const { guard, organizationId, requestOf } = build();
    await expect(
      guard.canActivate(contextOf(Routes.prototype.read, requestOf(null, organizationId))),
    ).rejects.toThrow(/before authentication/);
  });
});
