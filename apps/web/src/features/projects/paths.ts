/*
 * The URLs of the project pages (ADR-0012 D2): `/organizations/:organizationId/projects[/:projectId[/members]]`. The organization id in
 * the path is URL context, not authorization; the API still validates every selector. Built here because the pages link to each other
 * by absolute path, and re-exported by `app/` for the shell, which composes the organization switcher.
 */

export const organizationProjectsPath = (organizationId: string): string =>
  `/organizations/${encodeURIComponent(organizationId)}/projects`;

export const projectPath = (organizationId: string, projectId: string): string =>
  `${organizationProjectsPath(organizationId)}/${encodeURIComponent(projectId)}`;

export const projectMembersPath = (organizationId: string, projectId: string): string =>
  `${projectPath(organizationId, projectId)}/members`;
