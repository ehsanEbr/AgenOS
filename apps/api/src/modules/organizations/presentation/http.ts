import type { Principal } from '../../identity';
import type { TenantContext } from '../domain/tenant';

/*
 * The parts of an HTTP request this module uses, described structurally (the presentation layer may not import Express).
 * `auth` is attached by the global AuthenticationGuard of the identity module, which always runs before the guards below.
 */
export interface HttpRequest {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly auth?: { readonly principal: Principal };
  /** Set by `OrganizationAccessGuard` for a route that declared a permission. */
  tenant?: TenantContext;
}
