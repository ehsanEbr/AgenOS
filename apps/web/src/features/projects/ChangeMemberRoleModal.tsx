import { PROJECT_ROLES, type Project, type ProjectMember, type ProjectRole } from '@agentos/contracts';
import { Alert, Flex, Modal, Radio, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import { useChangeProjectMemberRole, useWriteFailureHandler } from './mutations';

interface ChangeMemberRoleModalProps {
  project: Project;
  member: ProjectMember;
  onClose: () => void;
  /** The signed-in user, so a change to the caller's own role also refreshes the project they are looking at. */
  callerId: string | undefined;
}

/**
 * Changes the project role of an EXPLICIT member. The chosen role is always sent: the row shown when the dialog opened may be stale (the
 * role can have changed on the server since), and the server treats a change to the role the member already has as a no-op that records
 * nothing, so comparing against the snapshot here could only lose a change. The backend has no
 * "last project admin" rule (ADR-0011: owners and admins always hold implicit access, so a project cannot become unmanageable), so the
 * form does not invent one: demoting the only project admin is offered like any other change, and the server's answer is what happens.
 *
 * If the member was removed meanwhile (`404 project_member_not_found`) the form closes after the members were refetched; if the project
 * was archived (`409`) it closes after the project was refetched; an uncertain result keeps the form with a notice.
 */
export function ChangeMemberRoleModal({ project, member, onClose, callerId }: ChangeMemberRoleModalProps) {
  const { t } = useTranslation('projects');
  const notify = useNotify();
  const change = useChangeProjectMemberRole();
  const handleFailure = useWriteFailureHandler({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const [role, setRole] = useState<ProjectRole>(member.role);
  const [uncertain, setUncertain] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const sending = useRef(false);

  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setUncertain(false);
    setInvalid(false);
    try {
      await change.mutateAsync({
        organizationId: project.organizationId,
        projectId: project.id,
        affectsCaller: member.userId === callerId,
        userId: member.userId,
        projectRole: role,
      });
      notify.success(t('members.changeRole.success'));
      onClose();
    } catch (error) {
      const failure = handleFailure(error);
      if (failure.kind === 'validation') setInvalid(true);
      else if (failure.kind === 'uncertain') setUncertain(true);
      else if (
        failure.kind === 'member_gone' ||
        failure.kind === 'access_changed' ||
        failure.kind === 'archived'
      )
        onClose();
    } finally {
      sending.current = false;
    }
  }

  const pending = change.isPending;
  return (
    <Modal
      open
      title={t('members.changeRole.title', { name: member.displayName })}
      okText={t('members.changeRole.submit')}
      cancelText={t('members.changeRole.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={pending}
      cancelButtonProps={{ disabled: pending }}
      closable={!pending}
      keyboard={!pending}
      maskClosable={false}
      destroyOnHidden
    >
      <Flex vertical gap="middle">
        {uncertain ? <Alert type="warning" showIcon title={t('write.uncertainInline')} /> : null}
        <Flex vertical gap={4}>
          <Typography.Text id="change-member-role">{t('members.changeRole.role')}</Typography.Text>
          <Radio.Group
            value={role}
            onChange={(event) => setRole(event.target.value as ProjectRole)}
            aria-labelledby="change-member-role"
          >
            {PROJECT_ROLES.map((value) => (
              <Radio key={value} value={value}>
                {t(`roles.${value}`)}
              </Radio>
            ))}
          </Radio.Group>
        </Flex>
        {invalid ? <Alert type="error" showIcon title={t('fields.invalid')} /> : null}
      </Flex>
    </Modal>
  );
}
