import { App } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { categorizeError, isApiClientError } from '../api/errors';

/**
 * Notifications for the outcome of a user action (a save succeeded, a mutation failed). Uses Ant Design's context-aware
 * instance, so notifications follow the active theme, language and text direction (static `message.xxx()` calls do not).
 *
 * Convention: a failed *query* renders an `ErrorState` in place; a failed *mutation* triggers `notify.error(error)`.
 */
export function useNotify() {
  const { notification } = App.useApp();
  const { t } = useTranslation('common');

  return useMemo(
    () => ({
      success: (title: string, description?: string) =>
        notification.success({ title, description, placement: 'bottom' }),
      info: (title: string, description?: string) =>
        notification.info({ title, description, placement: 'bottom' }),
      /** Accepts any caught error; ApiClientErrors get a localized message plus the support reference. */
      error: (error: unknown, title?: string) =>
        notification.error({
          title: title ?? t('errors.title'),
          description: [
            t(`errors.${categorizeError(error)}`),
            isApiClientError(error) && error.correlationId
              ? t('errors.reference', { id: error.correlationId })
              : null,
          ]
            .filter(Boolean)
            .join(' '),
          placement: 'bottom',
        }),
    }),
    [notification, t],
  );
}
