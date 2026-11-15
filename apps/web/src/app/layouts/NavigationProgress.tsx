import { Progress } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigation } from 'react-router';

/** Thin bar at the top of the viewport while a route (a lazy-loaded page, later a loader) is being fetched. */
export function NavigationProgress() {
  const { t } = useTranslation('shell');
  const { state } = useNavigation();
  if (state === 'idle') return null;

  return (
    <div
      className="navigation-progress"
      role="progressbar"
      aria-busy="true"
      aria-label={t('nav.loadingPage')}
    >
      <Progress percent={100} status="active" showInfo={false} size={['100%', 3]} />
    </div>
  );
}
