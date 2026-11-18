import { Alert, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { categorizeError, isApiClientError } from '../../shared/api/errors';
import type { AuthFailure } from './form-rules';

/**
 * One translated message for what went wrong with an authentication request. The server's own text is never shown: each documented
 * code has its own message, and anything else falls back to the shared categorized messages (network, timeout, server, ...) with the
 * support reference.
 */
export function FailureAlert({ failure }: { failure: AuthFailure }) {
  const { t } = useTranslation('auth');
  const { t: common } = useTranslation('common');

  switch (failure.kind) {
    case 'invalid_credentials':
      return <Alert type="error" showIcon title={t('errors.invalidCredentials')} />;
    case 'too_many_attempts':
      return <Alert type="error" showIcon title={t('errors.tooManyAttempts')} />;
    case 'unavailable':
      return <Alert type="error" showIcon title={t('errors.unavailable')} />;
    case 'origin_not_allowed':
      return <Alert type="error" showIcon title={t('errors.originNotAllowed')} />;
    case 'in_progress':
      return <Alert type="info" showIcon title={t('errors.inProgress')} />;
    case 'other': {
      const reference =
        isApiClientError(failure.error) && failure.error.correlationId
          ? common('errors.reference', { id: failure.error.correlationId })
          : null;
      return (
        <Alert
          type="error"
          showIcon
          title={common(`errors.${categorizeError(failure.error)}`)}
          description={
            reference ? <Typography.Text type="secondary">{reference}</Typography.Text> : undefined
          }
        />
      );
    }
    default:
      // A validation failure the form cannot attribute to a field, or a case the page handles itself.
      return <Alert type="error" showIcon title={common('errors.validation')} />;
  }
}
