import { Alert, Button, Empty, Flex, Result, Spin, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { categorizeError, isApiClientError } from '../api/errors';

/** Loading placeholder for a region or a whole page. Announced politely to screen readers. */
export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation('common');
  return (
    <Flex
      role="status"
      aria-live="polite"
      vertical
      align="center"
      justify="center"
      gap="middle"
      style={{ minBlockSize: 240 }}
    >
      <Spin size="large" />
      <Typography.Text type="secondary">{label ?? t('states.loading')}</Typography.Text>
    </Flex>
  );
}

interface EmptyStateProps {
  description: ReactNode;
  /** The next step for the user, for example a "Create" button. */
  action?: ReactNode;
}

/** "Nothing here yet" for a list or region. Always say what is empty and, when possible, what to do next. */
export function EmptyState({ description, action }: EmptyStateProps) {
  return (
    <Empty description={description} image={Empty.PRESENTED_IMAGE_SIMPLE}>
      {action}
    </Empty>
  );
}

interface ErrorStateProps {
  /** The caught error. Its category selects a localized message; backend text is never shown. */
  error?: unknown;
  title?: ReactNode;
  /** Overrides the message derived from `error`. */
  description?: ReactNode;
  /** Shows a retry button. Pass the query's `refetch`. */
  onRetry?: () => void;
  /** Extra actions (for example a link home). */
  extra?: ReactNode;
  /** `page`: centered, for a route or a whole region. `inline`: compact alert inside a card or form. */
  variant?: 'page' | 'inline';
  status?: 'error' | '404' | '403' | '500';
}

export function ErrorState({
  error,
  title,
  description,
  onRetry,
  extra,
  variant = 'page',
  status = 'error',
}: ErrorStateProps) {
  const { t } = useTranslation('common');

  const message = description ?? t(`errors.${categorizeError(error)}`);
  const reference =
    isApiClientError(error) && error.correlationId
      ? t('errors.reference', { id: error.correlationId })
      : null;
  const heading = title ?? t('errors.title');
  const retry = onRetry ? <Button onClick={onRetry}>{t('actions.retry')}</Button> : null;

  if (variant === 'inline') {
    return (
      <Alert
        type="error"
        showIcon
        title={heading}
        description={
          <>
            {message}
            {reference ? (
              <Typography.Text type="secondary" style={{ display: 'block' }}>
                {reference}
              </Typography.Text>
            ) : null}
          </>
        }
        action={retry}
      />
    );
  }

  return (
    <Result
      status={status}
      title={heading}
      subTitle={
        <>
          {message}
          {reference ? (
            <Typography.Text type="secondary" style={{ display: 'block' }}>
              {reference}
            </Typography.Text>
          ) : null}
        </>
      }
      extra={
        <>
          {retry}
          {extra}
        </>
      }
    />
  );
}
