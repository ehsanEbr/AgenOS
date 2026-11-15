import type { RouteObject } from 'react-router';
import type { RouteHandle } from '../../shared/routing/route-handle';

// Public interface of the `home` feature: its routes and its messages.
export { homeMessages } from './i18n';

const handle: RouteHandle = { titleKey: 'home:title' };

/**
 * The page is loaded lazily: its code is a separate chunk that is only downloaded when the route is visited.
 * `index.ts` itself stays tiny because it is part of the initial bundle.
 */
export const homeRoutes: RouteObject[] = [
  {
    index: true,
    handle,
    lazy: async () => ({ Component: (await import('./pages/HomePage')).HomePage }),
  },
];
