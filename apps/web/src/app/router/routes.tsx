import { Navigate, type RouteObject } from 'react-router';
import { RequireAuth, authRoutes } from '../../features/auth';
import { homeRoutes } from '../../features/home';
import { projectRoutes } from '../../features/projects';
import type { RouteHandle } from '../../shared/routing/route-handle';
import { LoadingState } from '../../shared/ui/states';
import { AppShell } from '../layouts/AppShell';
import { PublicLayout } from '../layouts/PublicLayout';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';

const notFoundHandle: RouteHandle = { titleKey: 'common:notFound.title' };
const chooserHandle: RouteHandle = { titleKey: 'organizations:chooser.title' };

/**
 * THE route table. Every URL the app serves is declared here (feature routes are spread in from the features'
 * public `index.ts`), so there is one place to look and one place to protect.
 *
 * Structure (ADR-0012 D4: the guard decides from the session state alone, and nothing else redirects):
 *
 *   PublicLayout (pathless)                         the public pages, rendered without the shell and without a session
 *     ├─ /sign-in
 *     └─ /sign-up
 *   RequireAuth (pathless)                          the session guard: private routes render only when authenticated
 *     └─ /  AppShell (persistent layout)            errorElement: shell failure, rendered without the shell
 *          └─ pathless group (error boundary)       errorElement: a page failure, rendered INSIDE the shell
 *               ├─ ...feature routes (lazy)
 *               ├─ /projects                              only a redirect: the last-used organization, else the chooser (D2)
 *               ├─ /organizations/:organizationId         the organization layout: resolves the organization, then renders below
 *               │    ├─ (index)                           -> projects
 *               │    └─ projects                          the project list, a project (details, members): features/projects
 *               └─ *  NotFoundPage
 *
 * Everything a signed-out visitor could reach other than the public pages is behind the guard, the not-found page included.
 */
export const routes: RouteObject[] = [
  {
    element: <PublicLayout />,
    errorElement: <RouteErrorPage />,
    HydrateFallback: LoadingState,
    children: authRoutes,
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorPage />,
    HydrateFallback: LoadingState,
    children: [
      {
        path: '/',
        element: <AppShell />,
        errorElement: <RouteErrorPage />,
        HydrateFallback: LoadingState,
        children: [
          {
            errorElement: <RouteErrorPage />,
            children: [
              ...homeRoutes,
              {
                path: 'projects',
                handle: chooserHandle,
                lazy: async () => ({ Component: (await import('./ProjectsEntryPage')).ProjectsEntryPage }),
              },
              {
                path: 'organizations/:organizationId',
                lazy: async () => ({ Component: (await import('./OrganizationRoute')).OrganizationRoute }),
                children: [
                  { index: true, element: <Navigate to="projects" replace /> },
                  { path: 'projects', children: projectRoutes },
                ],
              },
              { path: '*', element: <NotFoundPage />, handle: notFoundHandle },
            ],
          },
        ],
      },
    ],
  },
];
