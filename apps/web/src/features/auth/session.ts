import type { User } from '@agentos/contracts';

/*
 * The session vocabulary (ADR-0012 D4, rules 1 and 2). Pure data and predicates: no TanStack Query instance, no React.
 */

/** What the app needs to know about the signed-in user. */
export type SessionUser = Pick<User, 'id' | 'email' | 'displayName'>;

/**
 * The value of the ONE session entry. There are exactly three states:
 *  - authenticated: a user is signed in; private queries may run.
 *  - anonymous:     signed out or expired; a stable state that nothing refetches into a user.
 *  - unknown:       the app does not know (before the first answer, or after a sign-out whose outcome is uncertain).
 *                   An entry with no value yet is read as unknown. Private UI and private data must not exist in this state.
 */
export type SessionValue =
  | { readonly status: 'authenticated'; readonly user: SessionUser }
  | { readonly status: 'anonymous' }
  | {
      readonly status: 'unknown';
      /**
       * Set only by a sign-out whose outcome is uncertain (ADR-0012 D4 rule 6): the user asked to sign out and the server may or may
       * not have ended the session. While it is set no probe runs and the only ways out are the two definite sign-out outcomes or a
       * sign-in. It is part of the value (not separate state) so that every reader sees one source of truth.
       */
      readonly signOutUnresolved?: true;
    };

export const UNKNOWN_SESSION: SessionValue = { status: 'unknown' };
export const ANONYMOUS_SESSION: SessionValue = { status: 'anonymous' };
export const UNRESOLVED_SIGN_OUT: SessionValue = { status: 'unknown', signOutUnresolved: true };

/** The same published identity? Then publishing it again is not a transition (an authenticated value is only refreshed). */
export function isSameSession(a: SessionValue, b: SessionValue): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'authenticated' && b.status === 'authenticated') return a.user.id === b.user.id;
  if (a.status === 'unknown' && b.status === 'unknown')
    return Boolean(a.signOutUnresolved) === Boolean(b.signOutUnresolved);
  return true;
}

/** The key of the session entry. It is never removed, invalidated or cleared. */
export const SESSION_KEY = ['session'] as const;

/**
 * The query-key roots whose data is not private. Everything else is private (fail-closed): a query with an unknown or new root is
 * purged when the session ends or changes, and no query can opt itself out by metadata. Every feature's key factory begins with
 * its own root (`['projects', ...]`), so this list is the only place that grants publicity.
 */
export const PUBLIC_QUERY_ROOTS: readonly string[] = ['session', 'health'];

export function isPrivateQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root !== 'string' || !PUBLIC_QUERY_ROOTS.includes(root);
}
