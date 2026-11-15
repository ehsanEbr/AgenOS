import { Button } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router';
import { ErrorState } from '../../shared/ui/states';
import { NotFoundPage } from './NotFoundPage';

/**
 * Rendered by React Router when a route throws while loading or rendering (or a lazy chunk fails to download).
 * Used as the `errorElement` both inside the shell (navigation stays visible) and at the root (shell itself failed).
 */
export function RouteErrorPage() {
  const { t } = useTranslation('common');
  const error = useRouteError();
  const navigate = useNavigate();

  useEffect(() => {
    console.error('Route error', error);
  }, [error]);

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  return (
    <ErrorState
      description={t('boundary.description')}
      // A full reload also recovers from a failed lazy chunk (for example right after a new deployment).
      onRetry={() => window.location.reload()}
      extra={<Button onClick={() => void navigate('/')}>{t('actions.goHome')}</Button>}
    />
  );
}
