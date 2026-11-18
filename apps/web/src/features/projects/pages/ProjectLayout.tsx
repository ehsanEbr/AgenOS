import type { Project } from '@agentos/contracts';
import { Alert, Flex, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useParams } from 'react-router';
import { Page } from '../../../shared/ui/Page';
import { ErrorState, LoadingState } from '../../../shared/ui/states';
import { isNotFound } from '../errors';
import { projectMembersPath, projectPath } from '../paths';
import { ProjectActions } from '../ProjectActions';
import { ProjectNotFound } from '../ProjectNotFound';
import { useProject } from '../queries';

/** What the tabs of a project receive from the layout. */
export type ProjectOutletContext = Project;

/**
 * `/organizations/:organizationId/projects/:projectId`: the layout of a project's tabs (ADR-0012 D2). The project is loaded once here.
 * A project that is not under THIS organization's path is the same not-found as `404 project_not_found`: the same text, no field of the
 * project on screen, and the document title is the route's static title, never the project's name. The check guards against showing a
 * project under the wrong organization; it is not a security control (the API addresses projects by id and validates access).
 */
export function ProjectLayout() {
  const { t } = useTranslation('projects');
  const { token } = theme.useToken();
  const { organizationId = '', projectId } = useParams();
  const project = useProject(projectId);

  if (!project.valid || isNotFound(project.error)) return <ProjectNotFound />;
  if (project.isPending) return <LoadingState />;
  if (project.isError) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  if (project.data.organizationId !== organizationId) return <ProjectNotFound />;

  const data = project.data;
  const tab = ({ isActive }: { isActive: boolean }) => ({
    paddingBlock: token.paddingXS,
    paddingInline: token.padding,
    borderBlockEnd: `2px solid ${isActive ? token.colorPrimary : 'transparent'}`,
    fontWeight: isActive ? token.fontWeightStrong : undefined,
  });

  return (
    <Page title={data.name} description={data.slug} extra={<ProjectActions project={data} />}>
      <Flex vertical gap="middle">
        {data.status === 'archived' ? (
          <Alert type="warning" showIcon title={t('details.archivedNotice')} />
        ) : null}
        <nav aria-label={t('details.sections')}>
          <Flex gap="small" style={{ borderBlockEnd: `1px solid ${token.colorBorderSecondary}` }}>
            <NavLink to={projectPath(organizationId, data.id)} end style={tab}>
              {t('details.overview')}
            </NavLink>
            <NavLink to={projectMembersPath(organizationId, data.id)} style={tab}>
              {t('details.members')}
            </NavLink>
          </Flex>
        </nav>
        <Outlet context={data satisfies ProjectOutletContext} />
      </Flex>
    </Page>
  );
}
