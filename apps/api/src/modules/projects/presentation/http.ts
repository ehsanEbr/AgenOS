import type { Principal } from '../../identity';
import type { OrganizationContext, ProjectContext } from '../domain/project-context';

/*
 * The parts of an HTTP request this module uses, described structurally (the presentation layer may not import Express).
 * `auth` is attached by the global AuthenticationGuard of the identity module, which always runs before the guard of this module.
 */
export interface HttpRequest {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly auth?: { readonly principal: Principal };
  /** Set by `ProjectAccessGuard` on a project-addressed route. */
  projectContext?: ProjectContext;
  /** Set by `ProjectAccessGuard` on an organization-addressed route (list, create). */
  organizationContext?: OrganizationContext;
}
