import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ErrorState } from '../../shared/ui/states';

/**
 * The one state for an organization the caller cannot open (ADR-0012 D2): malformed, foreign or not a member are indistinguishable by
 * design, so the text never says which. The way out is the chooser, whose path the caller supplies.
 */
export function OrganizationNotFound({ chooserPath }: { chooserPath: string }) {
  const { t } = useTranslation('organizations');
  return (
    <ErrorState
      status="404"
      title={t('notFound.title')}
      description={t('notFound.description')}
      extra={
        <Link to={chooserPath}>
          <Button type="primary">{t('notFound.toChooser')}</Button>
        </Link>
      }
    />
  );
}
