/**
 * Which projects of an organization a caller may SEE (ADR-0011, decision 6, "Listing rules"). It is applied inside the query, before
 * filtering, counting and paging, so inaccessible projects never take part in any of them.
 *
 *   organization   every project of the organization (owner/admin: implicit administrative access)
 *   explicit       only the projects the caller has a project membership on (member/viewer)
 *
 * `userId` always comes from the authenticated principal, never from the request.
 */
export type ProjectVisibility =
  | { readonly kind: 'organization'; readonly userId: string }
  | { readonly kind: 'explicit'; readonly userId: string };

/**
 * `implicitAccess` is whether the caller's organization role holds `project.read` on every project, i.e. what the permission matrix
 * says; the matrix is the single place that decides it.
 */
export function visibilityFor(userId: string, implicitAccess: boolean): ProjectVisibility {
  return implicitAccess ? { kind: 'organization', userId } : { kind: 'explicit', userId };
}
