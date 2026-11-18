/*
 * What the auth pages exchange through the router's location state. It is a navigation hint, never authority: the destination after a
 * sign-in is validated here, and the session itself only ever comes from the session entry.
 */

export interface AuthNavigationState {
  /** Where the user was going when they were sent to sign in. */
  from?: { pathname: string; search: string; hash: string };
  /** The session ended without the user asking for it. */
  ended?: true;
  /** The account was just created (sign-up), so the sign-in page can say so and prefill the email. */
  registered?: true;
  email?: string;
}

/**
 * Where a user lands after signing in when nothing else was asked for (ADR-0012 D4): the projects entry, which is only a redirect to
 * the last-used organization or the chooser. The path is spelled out here because a feature cannot import the app's path builders.
 */
export const DEFAULT_AFTER_SIGN_IN = '/projects';

const AUTH_PATHS = ['/sign-in', '/sign-up'];

export function readAuthNavigationState(state: unknown): AuthNavigationState {
  if (typeof state !== 'object' || state === null) return {};
  const raw = state as Record<string, unknown>;
  const from = raw.from as Record<string, unknown> | undefined;
  return {
    ...(from &&
    typeof from.pathname === 'string' &&
    typeof from.search === 'string' &&
    typeof from.hash === 'string'
      ? { from: { pathname: from.pathname, search: from.search, hash: from.hash } }
      : {}),
    ...(raw.ended === true ? { ended: true as const } : {}),
    ...(raw.registered === true ? { registered: true as const } : {}),
    ...(typeof raw.email === 'string' ? { email: raw.email } : {}),
  };
}

/** The in-app destination for a "return to where I was" hint, or the default. Only same-app absolute paths are accepted. */
export function afterSignInTarget(from: AuthNavigationState['from']): string {
  if (!from) return DEFAULT_AFTER_SIGN_IN;
  const { pathname, search, hash } = from;
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\'))
    return DEFAULT_AFTER_SIGN_IN;
  if (AUTH_PATHS.includes(pathname)) return DEFAULT_AFTER_SIGN_IN;
  return `${pathname}${search}${hash}`;
}
