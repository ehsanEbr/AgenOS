import type { Project } from '@agentos/contracts';
import { Button, Flex, Pagination, Segmented, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Page } from '../../../shared/ui/Page';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/states';
import { usePermissionSubject } from '../access';
import { PROJECT_PAGE_SIZE } from '../api';
import { CreateProjectModal } from '../CreateProjectModal';
import { isForbidden } from '../errors';
import { formatDate } from '../format';
import { can } from '../permissions';
import { projectPath } from '../paths';
import { useProjectList, type ProjectListStatus } from '../queries';
import { ProjectForbidden } from '../ProjectNotFound';

const FILTERS: readonly ProjectListStatus[] = ['active', 'archived', 'all'];

/**
 * `/organizations/:organizationId/projects`: the projects of the organization in the URL that the caller can open (ADR-0012 D2, D5).
 * The paging controls and the status filter are the API's own (`limit`, `offset`, `status`); there is no sorting and no search because
 * the API has neither, and the order shown is the API's: oldest first. The list is keyed by the organization, so switching organization
 * starts from the first page of the new one and can never show the previous organization's rows.
 */
export function ProjectListPage() {
  const { organizationId = '' } = useParams();
  return <ProjectList key={organizationId} organizationId={organizationId} />;
}

function ProjectList({ organizationId }: { organizationId: string }) {
  const { t, i18n } = useTranslation('projects');
  const [status, setStatus] = useState<ProjectListStatus>('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const subject = usePermissionSubject(organizationId);
  const canCreate = subject !== null && can(subject, 'project.create');
  const offset = (page - 1) * PROJECT_PAGE_SIZE;
  const query = useProjectList(organizationId, status, offset);
  const total = query.data?.page.total ?? 0;

  // Rows can disappear while a page is open: never stay on a page past the end.
  const pastTheEnd =
    query.data !== undefined && query.data.items.length === 0 && total > 0 && offset >= total;
  useEffect(() => {
    if (pastTheEnd) setPage(Math.ceil(total / PROJECT_PAGE_SIZE));
  }, [pastTheEnd, total]);

  const columns = [
    {
      title: t('list.columns.name'),
      key: 'name',
      render: (_: unknown, project: Project) => (
        <Link to={projectPath(organizationId, project.id)}>{project.name}</Link>
      ),
    },
    { title: t('list.columns.slug'), dataIndex: 'slug', key: 'slug' },
    {
      title: t('list.columns.status'),
      key: 'status',
      render: (_: unknown, project: Project) => (
        <Tag color={project.status === 'archived' ? undefined : 'green'}>{t(`status.${project.status}`)}</Tag>
      ),
    },
    {
      title: t('list.columns.role'),
      key: 'role',
      render: (_: unknown, project: Project) =>
        project.projectRole ? t(`roles.${project.projectRole}`) : t('roles.viaOrganization'),
    },
    {
      title: t('list.columns.created'),
      key: 'created',
      render: (_: unknown, project: Project) => formatDate(project.createdAt, i18n.language),
    },
  ];

  let content;
  if (query.isPending || pastTheEnd) {
    content = <LoadingState />;
  } else if (query.isError) {
    content = isForbidden(query.error) ? (
      <ProjectForbidden />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  } else if (query.data.items.length === 0) {
    content = <EmptyState description={t(`list.empty.${status}`)} />;
  } else {
    const from = offset + 1;
    const to = offset + query.data.items.length;
    content = (
      <Flex vertical gap="middle">
        <Table<Project>
          rowKey="id"
          dataSource={query.data.items}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Typography.Text type="secondary" role="status">
            {t('list.showing', { from, to, total })}
          </Typography.Text>
          <nav aria-label={t('list.pagination')}>
            <Pagination
              current={page}
              pageSize={PROJECT_PAGE_SIZE}
              total={total}
              showSizeChanger={false}
              hideOnSinglePage
              onChange={setPage}
            />
          </nav>
        </Flex>
      </Flex>
    );
  }

  return (
    <Page
      title={t('list.title')}
      description={t('list.description')}
      extra={
        canCreate ? (
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('actions.create')}
          </Button>
        ) : null
      }
    >
      <Flex vertical gap="middle">
        <Flex align="center" gap="small" wrap>
          <Typography.Text id="project-status-filter">{t('list.filter.label')}</Typography.Text>
          <Segmented<ProjectListStatus>
            aria-labelledby="project-status-filter"
            value={status}
            options={FILTERS.map((value) => ({ value, label: t(`list.filter.${value}`) }))}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
        </Flex>
        {content}
      </Flex>
      {canCreate ? (
        <CreateProjectModal
          organizationId={organizationId}
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(project) => void navigate(projectPath(organizationId, project.id))}
        />
      ) : null}
    </Page>
  );
}
