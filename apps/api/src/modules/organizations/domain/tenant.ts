import type { OrganizationRole } from '@agentos/contracts';
import { idSchema } from '@agentos/contracts';

/**
 * Who is acting inside which organization, with which role (ADR-0010, decision 4). Produced only by `TenantAccess.resolve`, from the
 * authenticated principal and a membership read from the database on this request. Nothing downstream authorizes from a raw
 * organization id: a client-supplied id is only a selector that this value has validated.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
}

/**
 * The opaque proof a repository demands before it touches organization data. Every organization-scoped repository method takes one as
 * its first parameter and builds its WHERE from it. It is a class with a private constructor, so the only way to obtain one is
 * `scopeOf(tenant)`; a value that is missing, a plain object or carries a malformed id is refused by `requireScope` BEFORE any query:
 * the system fails closed, it never falls back to "no filter".
 */
export class OrganizationScope {
  private constructor(readonly organizationId: string) {}

  static of(organizationId: string): OrganizationScope {
    return new OrganizationScope(organizationId);
  }
}

export function scopeOf(tenant: TenantContext): OrganizationScope {
  return requireScope(OrganizationScope.of(tenant?.organizationId));
}

/** Throws a plain Error (an unexpected 500, never a client-facing answer) unless `scope` is a genuine scope with a valid id. */
export function requireScope(scope: unknown): OrganizationScope {
  if (!(scope instanceof OrganizationScope) || !idSchema.safeParse(scope.organizationId).success)
    throw new Error('An organization-scoped repository was called without a valid OrganizationScope');
  return scope;
}
