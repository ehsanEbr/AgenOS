import { useQuery, useQueryClient } from '@tanstack/react-query';
import { login, register } from './api';
import { useCredentialMutation } from './credential-mutation';
import { UNKNOWN_SESSION, type SessionUser, type SessionValue } from './session';
import { requireSessionLifecycle } from './session-lifecycle';
import { sessionQueryOptions } from './session-probe';
import { clearDeliberateSignOut } from './sign-out';

/**
 * The session as a component sees it: the value of the ONE session entry (`['session']`, ADR-0012 D4 rule 2), kept fresh by the
 * probe (`GET /me`). There is no second source of session truth: nothing else stores who is signed in.
 *
 * `error` is the probe's failure and is only meaningful while the value is unknown (a failed check of an authenticated or anonymous
 * session changes nothing). `retry` joins a probe already running instead of restarting it.
 */
export function useSession() {
  const client = useQueryClient();
  const query = useQuery(sessionQueryOptions(client));

  const value: SessionValue = query.data ?? UNKNOWN_SESSION;
  return {
    value,
    checking: value.status === 'unknown' && query.isFetching,
    error: value.status === 'unknown' ? query.error : null,
    retry: () => void query.refetch({ cancelRefetch: false }),
  };
}

/** The signed-in user, or null (also while the session is unknown or anonymous). */
export function useCurrentUser(): SessionUser | null {
  const { value } = useSession();
  return value.status === 'authenticated' ? value.user : null;
}

/**
 * Sign-in: a credential mutation (the password never enters the mutation cache, see `credential-mutation.ts`).
 * On success the session becomes authenticated through the transition block.
 */
export function useSignIn() {
  const client = useQueryClient();
  return useCredentialMutation('sign-in', async (credentials: { email: string; password: string }) => {
    const { user } = await login(credentials);
    clearDeliberateSignOut(client);
    requireSessionLifecycle(client).transition({
      status: 'authenticated',
      user: { id: user.id, email: user.email, displayName: user.displayName },
    });
    return user;
  });
}

/** Sign-up: creates the account only. The API does not sign the new user in, so the flow continues on the sign-in page. */
export function useSignUp() {
  return useCredentialMutation('sign-up', register);
}
