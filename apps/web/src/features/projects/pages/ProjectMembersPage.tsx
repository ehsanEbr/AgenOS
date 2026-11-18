import type { Project, ProjectMember } from '@agentos/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Flex, Pagination, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOutletContext } from 'react-router';
import { EmptyState, ErrorState, LoadingState } from '../../../shared/ui/states';
import { useCurrentUser } from '../../auth';
import { usePermissionSubject } from '../access';
import { AddMemberModal } from '../AddMemberModal';
import { PROJECT_PAGE_SIZE } from '../api';
import { ChangeMemberRoleModal } from '../ChangeMemberRoleModal';
import { isForbidden, isNotFound } from '../errors';
import { formatDate } from '../format';
import { can, projectActions } from '../permissions';
import { ProjectForbidden, ProjectNotFound } from '../ProjectNotFound';
import { projectKeys, useProjectMembers } from '../queries';
import { RemoveMemberModal } from '../RemoveMemberModal';
import type { ProjectOutletContext } from './ProjectLayout';

/**
 * The second tab of a project: its EXPLICIT members, paged with the API's own `limit` and `offset` (ADR-0012 V2, D5). There is no
 * filter, search or sorting because the endpoint has none. It works on an archived project. The signed-in user is marked "You".
 * A `403` or `404` here means the person's access changed: the project is refetched so the layout above re-evaluates it.
 *
 * Adding, changing the role of and removing members (ADR-0012 step 6) are offered as the permission helper's `manageMembers` action
 * says: hidden without the permission, shown DISABLED with the reason on an archived project, nothing at all until the caller's
 * organization role is known. The server re-evaluates every request. The table lists explicit memberships only; an organization owner
 * or admin who holds no project role is not a row here, and is not made one by anything on this page.
 */
export function ProjectMembersPage() {
  const project = useOutletContext<ProjectOutletContext>();
  // Keyed by the project, so another project starts from its first page.
  return <ProjectMembers key={project.id} project={project} />;
}

function ProjectMembers({ project }: { project: Project }) {
  const projectId = project.id;
  const { t, i18n } = useTranslation('projects');
  const client = useQueryClient();
  const me = useCurrentUser();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const subject = usePermissionSubject(project.organizationId, project.projectRole);
  const manage = subject ? projectActions(subject, project.status).manageMembers : 'hidden';
  // The dialogs exist only while the member controls are enabled. Forget them when that ends, so that regaining the permission (a project
  // restored, a role given back) does not bring a stale dialog back.
  useEffect(() => {
    if (manage !== 'enabled') {
      setAdding(false);
      setChanging(null);
      setRemoving(null);
    }
  }, [manage]);
  // Removing oneself: does the caller still reach the project through their organization role (owner or admin)?
  const callerKeepsAccess =
    subject !== null && can({ organizationRole: subject.organizationRole }, 'project.read');
  const offset = (page - 1) * PROJECT_PAGE_SIZE;
  const query = useProjectMembers(projectId, offset);
  const total = query.data?.page.total ?? 0;

  const accessChanged = isForbidden(query.error) || isNotFound(query.error);
  useEffect(() => {
    if (accessChanged) void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
  }, [accessChanged, client, projectId]);

  const pastTheEnd =
    query.data !== undefined && query.data.items.length === 0 && total > 0 && offset >= total;
  useEffect(() => {
    if (pastTheEnd) setPage(Math.ceil(total / PROJECT_PAGE_SIZE));
  }, [pastTheEnd, total]);

  const columns = [
    {
      title: t('members.columns.name'),
      key: 'name',
      render: (_: unknown, member: ProjectMember) => (
        <Flex align="center" gap="small" wrap>
          {member.displayName}
          {member.userId === me?.id ? <Tag color="blue">{t('members.you')}</Tag> : null}
        </Flex>
      ),
    },
    { title: t('members.columns.email'), dataIndex: 'email', key: 'email' },
    {
      title: t('members.columns.role'),
      key: 'role',
      render: (_: unknown, member: ProjectMember) => t(`roles.${member.role}`),
    },
    {
      title: t('members.columns.joined'),
      key: 'joined',
      render: (_: unknown, member: ProjectMember) => formatDate(member.joinedAt, i18n.language),
    },
    ...(manage === 'hidden'
      ? []
      : [
          {
            title: t('members.actions.column'),
            key: 'actions',
            render: (_: unknown, member: ProjectMember) => (
              // A disabled button shows no tooltip of its own, so the reason sits on a wrapper the pointer can reach.
              <span title={manage === 'disabled_archived' ? t('members.actions.archivedReason') : undefined}>
                <Flex gap="small" wrap>
                  <Button
                    size="small"
                    disabled={manage !== 'enabled'}
                    aria-label={t('members.actions.changeRoleFor', { name: member.displayName })}
                    onClick={() => setChanging(member)}
                  >
                    {t('members.actions.changeRole')}
                  </Button>
                  <Button
                    size="small"
                    danger
                    disabled={manage !== 'enabled'}
                    aria-label={t('members.actions.removeFor', { name: member.displayName })}
                    onClick={() => setRemoving(member)}
                  >
                    {t('members.actions.remove')}
                  </Button>
                </Flex>
              </span>
            ),
          },
        ]),
  ];

  let content;
  if (query.isPending || pastTheEnd) {
    content = <LoadingState />;
  } else if (query.isError) {
    if (isNotFound(query.error)) content = <ProjectNotFound />;
    else if (isForbidden(query.error)) content = <ProjectForbidden />;
    else content = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (query.data.items.length === 0) {
    content = <EmptyState description={t('members.empty')} />;
  } else {
    const from = offset + 1;
    const to = offset + query.data.items.length;
    content = (
      <Flex vertical gap="middle">
        <Table<ProjectMember>
          rowKey="userId"
          dataSource={query.data.items}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Typography.Text type="secondary" role="status">
            {t('members.showing', { from, to, total })}
          </Typography.Text>
          <nav aria-label={t('members.pagination')}>
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
    <Flex vertical gap="middle">
      <Flex justify="space-between" align="flex-start" gap="middle" wrap>
        <Typography.Paragraph type="secondary" style={{ marginBlock: 0, flex: 1, minInlineSize: 240 }}>
          {t('members.note')}
        </Typography.Paragraph>
        {manage === 'hidden' ? null : (
          <span title={manage === 'disabled_archived' ? t('members.actions.archivedReason') : undefined}>
            <Button type="primary" disabled={manage !== 'enabled'} onClick={() => setAdding(true)}>
              {t('members.actions.add')}
            </Button>
          </span>
        )}
      </Flex>
      {content}
      {manage === 'enabled' ? (
        <>
          <AddMemberModal
            project={project}
            open={adding}
            onClose={() => setAdding(false)}
            callerId={me?.id}
          />
          {changing ? (
            <ChangeMemberRoleModal
              project={project}
              member={changing}
              callerId={me?.id}
              onClose={() => setChanging(null)}
            />
          ) : null}
          {removing ? (
            <RemoveMemberModal
              project={project}
              member={removing}
              callerId={me?.id}
              callerKeepsAccess={callerKeepsAccess}
              onClose={() => setRemoving(null)}
            />
          ) : null}
        </>
      ) : null}
    </Flex>
  );
}
