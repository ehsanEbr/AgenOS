import { Button, Flex, Result } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { useQueryClient } from '@tanstack/react-query';
import { isDeliberateSignOut, useSignOut } from './sign-out';
import { useSession } from './use-session';
import type { AuthNavigationState } from './navigation-state';
import type { SessionValue } from './session';

/** A full-page status screen (the session has not been established, so there is no application shell to put it in). */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <Flex align="center" justify="center" style={{ minBlockSize: '100vh', padding: 16 }}>
      {children}
    </Flex>
  );
}

/** Shown while a sign-out is unresolved: the private UI is gone and the user can only finish signing out or sign in again. */
function SignOutIncomplete() {
  const { t } = useTranslation('auth');
  const signOut = useSignOut();
  return (
    <Screen>
      <Result
        status="warning"
        title={t('session.incompleteTitle')}
        subTitle={t('session.incompleteDescription')}
        extra={[
          <Button key="retry" type="primary" loading={signOut.isPending} onClick={() => signOut.mutate()}>
            {t('session.retrySignOut')}
          </Button>,
          <Link key="sign-in" to="/sign-in">
            <Button>{t('session.toSignIn')}</Button>
          </Link>,
        ]}
      />
    </Screen>
  );
}

/**
 * The route guard (ADR-0012 D4). Navigation is a function of the session state ALONE:
 *   authenticated -> the private routes, in an <Outlet> keyed by the user id, so a different user gets a fresh subtree and no
 *                    component, hook or observer of the previous user survives;
 *   anonymous     -> redirect to the sign-in page, remembering where the user was going;
 *   unknown       -> never a redirect and never private UI: a loading state, an error with Retry when the check failed, or the
 *                    "sign-out is not complete" screen while a sign-out is unresolved.
 * It is the only thing that redirects on a session change; no cache callback navigates.
 */
export function RequireAuth() {
  const { t } = useTranslation('auth');
  const client = useQueryClient();
  const location = useLocation();
  const session = useSession();
  const { value } = session;

  // The session ended mid-visit (as opposed to the user arriving without one): tell them once, on the sign-in page.
  const previous = useRef<SessionValue['status']>('unknown');
  const wasAuthenticated = previous.current === 'authenticated';
  useEffect(() => {
    previous.current = value.status;
  }, [value.status]);

  if (value.status === 'authenticated') return <Outlet key={value.user.id} />;

  if (value.status === 'anonymous') {
    const state: AuthNavigationState = {
      from: { pathname: location.pathname, search: location.search, hash: location.hash },
      ...(wasAuthenticated && !isDeliberateSignOut(client) ? { ended: true as const } : {}),
    };
    return <Navigate to="/sign-in" replace state={state} />;
  }

  if (value.signOutUnresolved) return <SignOutIncomplete />;
  if (session.error)
    return (
      <Screen>
        <ErrorState error={session.error} title={t('session.failedTitle')} onRetry={session.retry} />
      </Screen>
    );
  return (
    <Screen>
      <LoadingState label={t('session.checking')} />
    </Screen>
  );
}
