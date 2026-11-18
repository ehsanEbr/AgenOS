import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { ErrorState } from '../../shared/ui/states';
import { organizationProjectsPath } from './paths';

/**
 * The one state for a project the caller cannot open (ADR-0012 D2, V9): it does not exist, belongs to another organization, the caller has
 * no access, or the project is reachable but not under THIS organization's path. The text is the same for all of them, shows no field
 * of the project (name, status, description) and never says that the project exists elsewhere.
 */
export function ProjectNotFound() {
  const { t } = useTranslation('projects');
  const { organizationId = '' } = useParams();
  return (
    <ErrorState
      status="404"
      title={t('notFound.title')}
      description={t('notFound.description')}
      extra={
        <Link to={organizationProjectsPath(organizationId)}>
          <Button type="primary">{t('notFound.back')}</Button>
        </Link>
      }
    />
  );
}

/** A refusal (`403`) on the read side: the person's access changed. Nothing about the project is shown. */
export function ProjectForbidden() {
  const { t } = useTranslation('projects');
  const { organizationId = '' } = useParams();
  return (
    <ErrorState
      status="403"
      title={t('forbidden.title')}
      description={t('forbidden.description')}
      extra={
        <Link to={organizationProjectsPath(organizationId)}>
          <Button type="primary">{t('notFound.back')}</Button>
        </Link>
      }
    />
  );
}
