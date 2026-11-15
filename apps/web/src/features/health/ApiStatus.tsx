import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { useApiHealth } from './queries';

/**
 * Shows whether the web app can reach the API. It exists to prove the client + shared-contract wiring end to end,
 * and doubles as the connectivity indicator in the shell header.
 */
export function ApiStatus() {
  const { t } = useTranslation('health');
  const { isPending, isError } = useApiHealth();

  // role="status" announces changes ("unreachable") to assistive technology without moving focus.
  if (isPending) return <Tag role="status">{t('status.checking')}</Tag>;
  if (isError)
    return (
      <Tag role="status" color="error">
        {t('status.unreachable')}
      </Tag>
    );
  return (
    <Tag role="status" color="success">
      {t('status.ok')}
    </Tag>
  );
}
