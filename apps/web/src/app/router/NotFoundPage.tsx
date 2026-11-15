import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ErrorState } from '../../shared/ui/states';

export function NotFoundPage() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  return (
    <ErrorState
      status="404"
      title={t('notFound.title')}
      description={t('notFound.description')}
      extra={
        <Button type="primary" onClick={() => void navigate('/')}>
          {t('actions.goHome')}
        </Button>
      }
    />
  );
}
