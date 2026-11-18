import { PROJECT_ROLES, type Project, type ProjectRole } from '@agentos/contracts';
import { Alert, Button, Flex, Input, Modal, Radio, Tag, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorState, LoadingState } from '../../shared/ui/states';
import { useNotify } from '../../shared/ui/useNotify';
import { useAddProjectMember, useWriteFailureHandler } from './mutations';
import { useOrganizationMembers, useProjectMemberIds } from './queries';

type Problem = 'chooseMember' | 'alreadyMember' | 'memberUnavailable' | 'invalid';

interface AddMemberModalProps {
  project: Project;
  open: boolean;
  onClose: () => void;
  /** The signed-in user, so a change to the caller's own membership also refreshes the project they are looking at. */
  callerId: string | undefined;
}

/**
 * Adds a member to the project from the members of its organization (ADR-0012 D5).
 *
 * The picker reads `GET /organizations/:id/members`, which is paged (100 per request) and has NO search: it lists the rows loaded so far,
 * says how many of the total they are, and its search box filters only those rows (and says so). It never claims to have searched the
 * rest; "Load more" fetches the next page. People who are members of the project already are shown disabled once ALL the project's
 * members are known; until then nothing is disabled, and the server stays the authority (`409 already_project_member`).
 *
 * The picker adds an existing ORGANIZATION member to the project. It never changes anyone's organization membership, and an organization
 * owner or admin is not treated as a project member merely because they can open every project.
 *
 * One request per submission. A result that cannot be confirmed (network, timeout, 5xx) keeps the form open with a notice: the members
 * were refetched, and repeating the submission cannot add the same person twice (the server answers `409`). Enter in the search box does
 * not submit.
 */
export function AddMemberModal({ project, open, onClose, callerId }: AddMemberModalProps) {
  const { t } = useTranslation('projects');
  const notify = useNotify();
  const people = useOrganizationMembers(project.organizationId, open);
  const existing = useProjectMemberIds(project.id, open);
  const add = useAddProjectMember();
  const handleFailure = useWriteFailureHandler({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const [selected, setSelected] = useState<string | undefined>();
  const [role, setRole] = useState<ProjectRole>('project_member');
  const [search, setSearch] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const sending = useRef(false);

  const loaded = people.data?.pages.flatMap((page) => page.items) ?? [];
  const total = people.data?.pages.at(-1)?.page.total ?? 0;
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? loaded.filter((person) => `${person.displayName} ${person.email}`.toLowerCase().includes(needle))
    : loaded;

  async function submit() {
    if (sending.current) return;
    if (!selected) {
      setProblem('chooseMember');
      return;
    }
    sending.current = true;
    setProblem(null);
    setUncertain(false);
    try {
      await add.mutateAsync({
        organizationId: project.organizationId,
        projectId: project.id,
        affectsCaller: selected === callerId,
        userId: selected,
        projectRole: role,
      });
      notify.success(t('members.add.success'));
      onClose();
    } catch (error) {
      const failure = handleFailure(error);
      if (failure.kind === 'already_member') {
        // Known to fail: forget the choice, so the same request cannot be sent again without choosing someone.
        setProblem('alreadyMember');
        setSelected(undefined);
      } else if (failure.kind === 'member_unavailable') {
        setProblem('memberUnavailable');
        setSelected(undefined);
      } else if (failure.kind === 'validation') setProblem('invalid');
      else if (failure.kind === 'uncertain') setUncertain(true);
      else if (failure.kind === 'access_changed' || failure.kind === 'archived') onClose();
    } finally {
      sending.current = false;
    }
  }

  let list;
  if (people.isPending) list = <LoadingState />;
  else if (people.isError)
    list = (
      <ErrorState
        variant="inline"
        error={people.error}
        title={t('members.add.loadFailed')}
        onRetry={() => void people.refetch()}
      />
    );
  else if (loaded.length === 0)
    list = <Typography.Text type="secondary">{t('members.add.empty')}</Typography.Text>;
  else if (shown.length === 0)
    list = <Typography.Text type="secondary">{t('members.add.noMatch')}</Typography.Text>;
  else
    list = (
      <Radio.Group
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value as string);
          setProblem(null);
        }}
        aria-label={t('members.add.members')}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, maxBlockSize: 240, overflowY: 'auto' }}
      >
        {shown.map((person) => {
          const already = existing.ids?.has(person.userId) ?? false;
          return (
            <Radio key={person.userId} value={person.userId} disabled={already}>
              <Flex gap="small" align="center" wrap>
                <span>
                  {person.displayName} ({person.email})
                </span>
                <Tag style={{ marginInlineEnd: 0 }}>{t(`orgRoles.${person.role}`)}</Tag>
                {already ? (
                  <Typography.Text type="secondary">{t('members.add.alreadyMember')}</Typography.Text>
                ) : null}
              </Flex>
            </Radio>
          );
        })}
      </Radio.Group>
    );

  const pending = add.isPending;
  return (
    <Modal
      open={open}
      title={t('members.add.title')}
      okText={t('members.add.submit')}
      cancelText={t('members.add.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={pending}
      cancelButtonProps={{ disabled: pending }}
      closable={!pending}
      keyboard={!pending}
      maskClosable={false}
      destroyOnHidden
      afterClose={() => {
        setSelected(undefined);
        setRole('project_member');
        setSearch('');
        setProblem(null);
        setUncertain(false);
      }}
    >
      <Flex vertical gap="middle">
        <Typography.Paragraph type="secondary" style={{ marginBlock: 0 }}>
          {t('members.add.hint')}
        </Typography.Paragraph>
        {uncertain ? <Alert type="warning" showIcon title={t('write.uncertainInline')} /> : null}

        <Flex vertical gap={4}>
          <Input
            aria-label={t('members.add.search')}
            placeholder={t('members.add.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={(event) => event.preventDefault()}
            allowClear
          />
          <Typography.Text type="secondary">{t('members.add.searchHint')}</Typography.Text>
        </Flex>

        {list}

        {people.isSuccess ? (
          <Flex justify="space-between" align="center" gap="small" wrap>
            <Typography.Text type="secondary" role="status">
              {t(people.hasNextPage ? 'members.add.showingMore' : 'members.add.showing', {
                loaded: loaded.length,
                total,
              })}
            </Typography.Text>
            {people.hasNextPage ? (
              <Button loading={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>
                {t('members.add.loadMore')}
              </Button>
            ) : null}
          </Flex>
        ) : null}

        <Flex vertical gap={4}>
          <Typography.Text id="add-member-role">{t('members.add.role')}</Typography.Text>
          <Radio.Group
            value={role}
            onChange={(event) => setRole(event.target.value as ProjectRole)}
            aria-labelledby="add-member-role"
          >
            {PROJECT_ROLES.map((value) => (
              <Radio key={value} value={value}>
                {t(`roles.${value}`)}
              </Radio>
            ))}
          </Radio.Group>
        </Flex>

        {problem ? <Alert type="error" showIcon title={t(`fields.${problem}`)} /> : null}
      </Flex>
    </Modal>
  );
}
