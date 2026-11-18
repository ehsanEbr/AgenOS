/*
 * Path builders for the organization-scoped pages (ADR-0012 D2). They live in `app/` because the features do not know each other's
 * routes: the organizations feature takes the target path from the caller, and the route table and the shell compose them here.
 */

/** The entry point of the project pages. It is only a redirect: to the last-used organization when it is valid, else the chooser. */
export const PROJECTS_ENTRY_PATH = '/projects';

/**
 * The project list of one organization. The organization id in the path is URL context, not authorization. The builder is defined by
 * the projects feature, which owns the pages below it, so the route table, the shell and the pages cannot disagree about the URL.
 */
export { organizationProjectsPath } from '../../features/projects';
