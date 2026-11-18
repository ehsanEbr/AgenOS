import type { Project, ProjectMember } from '@agentos/contracts';
import { Alert, Flex, Modal, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import { useRemoveProjectMember, useWriteFailureHandler } from './mutations';

interface RemoveMemberModalProps {
  project: Project;
  member: ProjectMember;
  /** The signed-in user. Removing oneself carries a warning (ADR-0012 step 6). */
  callerId: string | undefined;
  /** Whether the caller reaches every project through their organization role (owner or admin), whatever happens to their project role. */
  callerKeepsAccess: boolean;
  onClose: () => void;
}

/**
 * Removes an EXPLICIT member from the project, after a confirmation. Their organization membership is not affected, and an organization
 * owner or admin keeps access to every project. Removing oneself asks again in stronger terms: a project admin who is not an
 * organization owner or admin loses access to the project altogether (the project then answers `404` to them).
 *
 * The backend has no "last project admin" rule (ADR-0011), so none is invented here. If the member was already removed
 * (`404 project_member_not_found`) the dialog closes after the members were refetched.
 */
export function RemoveMemberModal({
  project,
  member,
  callerId,
  callerKeepsAccess,
  onClose,
}: RemoveMemberModalProps) {
  const { t } = useTranslation('projects');
  const notify = useNotify();
  const remove = useRemoveProjectMember();
  const handleFailure = useWriteFailureHandler({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const [uncertain, setUncertain] = useState(false);
  const sending = useRef(false);
  const self = member.userId === callerId;

  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setUncertain(false);
    try {
      await remove.mutateAsync({
        organizationId: project.organizationId,
        projectId: project.id,
        affectsCaller: self,
        userId: member.userId,
      });
      notify.success(t('members.remove.success'), member.displayName);
      onClose();
    } catch (error) {
      const failure = handleFailure(error);
      if (failure.kind === 'uncertain') setUncertain(true);
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

  const pending = remove.isPending;
  return (
    <Modal
      open
      title={self ? t('members.remove.selfTitle') : t('members.remove.title', { name: member.displayName })}
      okText={t('members.remove.submit')}
      cancelText={t('members.remove.cancel')}
      okButtonProps={{ danger: true }}
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
        <Typography.Paragraph style={{ marginBlock: 0 }}>
          {t(self ? 'members.remove.selfBody' : 'members.remove.body')}
        </Typography.Paragraph>
        {self ? (
          <Alert
            type={callerKeepsAccess ? 'info' : 'warning'}
            showIcon
            title={t(callerKeepsAccess ? 'members.remove.selfKeepsAccess' : 'members.remove.selfLosesAccess')}
          />
        ) : null}
      </Flex>
    </Modal>
  );
}
