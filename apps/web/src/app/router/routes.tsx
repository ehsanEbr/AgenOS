import type { RouteObject } from 'react-router';
import { homeRoutes } from '../../features/home';
import type { RouteHandle } from '../../shared/routing/route-handle';
import { LoadingState } from '../../shared/ui/states';
import { AppShell } from '../layouts/AppShell';
import { NotFoundPage } from './NotFoundPage';
import { RouteErrorPage } from './RouteErrorPage';

const notFoundHandle: RouteHandle = { titleKey: 'common:notFound.title' };

/**
 * THE route table. Every URL the app serves is declared here (feature routes are spread in from the features'
 * public `index.ts`), so there is one place to look and one place to protect.
 *
 * Structure:
 *   /  AppShell (persistent layout)                 errorElement: shell failure, rendered without the shell
 *     └─ pathless group (error boundary)            errorElement: a page failure, rendered INSIDE the shell
 *          ├─ ...feature routes (lazy)
 *          └─ *  NotFoundPage
 *
 * Adding authentication later does not change this shape: insert a pathless route with a guard element or `loader`
 * between the shell's children and the feature routes (or around the shell for fully private apps), for example
 *   { element: <RequireAuth />, children: [ ...featureRoutes ] }
 * Public routes such as a sign-in page stay outside that group.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    HydrateFallback: LoadingState,
    children: [
      {
        errorElement: <RouteErrorPage />,
        children: [...homeRoutes, { path: '*', element: <NotFoundPage />, handle: notFoundHandle }],
      },
    ],
  },
];
