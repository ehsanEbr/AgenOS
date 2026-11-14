import { useTranslation } from 'react-i18next';
import { Page } from '../../../shared/ui/Page';

/** Placeholder landing page. Deliberately has no data and no widgets: product pages arrive with their features. */
export function HomePage() {
  const { t } = useTranslation('home');
  return <Page title={t('title')} description={t('description')} />;
}
