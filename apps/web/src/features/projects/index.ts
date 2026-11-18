import type { RouteObject } from 'react-router';
import type { RouteHandle } from '../../shared/routing/route-handle';

// Public interface of the `projects` feature (the read side: list, details, members). Other code imports from here, never from the
// files behind it. `projects` imports one other feature, `auth`, through its `index.ts` (the signed-in user, to mark "You").
export { projectMessages } from './i18n';
export { organizationProjectsPath, projectMembersPath, projectPath } from './paths';

// A handle's title is static on purpose: a project's name must never reach the document title (ADR-0012 D2, mismatch rule).
const listHandle: RouteHandle = { titleKey: 'projects:list.title' };
const detailsHandle: RouteHandle = { titleKey: 'projects:details.title' };
const membersHandle: RouteHandle = { titleKey: 'projects:members.title' };

/**
 * The routes below `/organizations/:organizationId/projects`, mounted by `app/` under the organization layout. The pages are loaded
 * lazily: their code is a separate chunk that is only downloaded when a route is visited, and this file stays tiny because it is
 * part of the initial bundle.
 */
export const projectRoutes: RouteObject[] = [
  {
    index: true,
    handle: listHandle,
    lazy: async () => ({ Component: (await import('./pages/ProjectListPage')).ProjectListPage }),
  },
  {
    path: ':projectId',
    lazy: async () => ({ Component: (await import('./pages/ProjectLayout')).ProjectLayout }),
    children: [
      {
        index: true,
        handle: detailsHandle,
        lazy: async () => ({ Component: (await import('./pages/ProjectOverviewPage')).ProjectOverviewPage }),
      },
      {
        path: 'members',
        handle: membersHandle,
        lazy: async () => ({ Component: (await import('./pages/ProjectMembersPage')).ProjectMembersPage }),
      },
    ],
  },
];
