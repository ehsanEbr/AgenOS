import type { RouteObject } from 'react-router';
import type { RouteHandle } from '../../shared/routing/route-handle';

// Public interface of the `auth` feature. Other code imports from here, never from the files behind it.
// Not exported on purpose: `auth-mutation.ts` (the marker that exempts authentication mutations from the session gate).
export { authMessages } from './i18n';
export { RequireAuth } from './RequireAuth';
export { UserMenu } from './UserMenu';
export { useCurrentUser } from './use-session';
export {
  PUBLIC_QUERY_ROOTS,
  SESSION_KEY,
  UNKNOWN_SESSION,
  isPrivateQueryKey,
  type SessionUser,
  type SessionValue,
} from './session';
export {
  SessionLifecycle,
  SessionNotAuthenticatedError,
  requireSessionLifecycle,
  type SessionLifecycleOptions,
} from './session-lifecycle';

const signInHandle: RouteHandle = { titleKey: 'auth:signIn.title' };
const signUpHandle: RouteHandle = { titleKey: 'auth:signUp.title' };

/**
 * The PUBLIC routes (outside the session guard, rendered without the application shell). The pages are loaded lazily; this file
 * stays tiny because it is part of the initial bundle.
 */
export const authRoutes: RouteObject[] = [
  {
    path: 'sign-in',
    handle: signInHandle,
    lazy: async () => ({ Component: (await import('./pages/SignInPage')).SignInPage }),
  },
  {
    path: 'sign-up',
    handle: signUpHandle,
    lazy: async () => ({ Component: (await import('./pages/SignUpPage')).SignUpPage }),
  },
];
