import type { Project } from '@agentos/contracts';
import { Button, Flex, Modal } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import { usePermissionSubject } from './access';
import { EditProjectModal } from './EditProjectModal';
import { useArchiveProject, useRestoreProject, useWriteFailureHandler } from './mutations';
import { projectActions, type ActionState } from './permissions';

const shown = (state: ActionState) => state !== 'hidden';

/**
 * The actions of a project page: edit, archive, restore (ADR-0012 D3). Which of them are shown is decided by the permission helper from
 * the caller's organization role and their explicit role on the project, and by the project's status (an archived project is read-only:
 * Edit stays visible but disabled, with the reason). Nothing is offered until the organization role is known. The helper only chooses what
 * to SHOW: the server re-evaluates every request, and a refusal means "your access changed" (the page refetches and redraws).
 *
 * Archiving asks for a confirmation; restoring does not (it loses nothing). Both are idempotent on the server. While one runs, the
 * buttons are disabled and a second activation in the same tick sends nothing.
 */
export function ProjectActions({ project }: { project: Project }) {
  const { t } = useTranslation('projects');
  const notify = useNotify();
  const subject = usePermissionSubject(project.organizationId, project.projectRole);
  const archive = useArchiveProject();
  const restore = useRestoreProject();
  const handleFailure = useWriteFailureHandler({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const running = useRef(false);

  if (!subject) return null;
  const actions = projectActions(subject, project.status);
  const busy = archive.isPending || restore.isPending;

  async function run(change: 'archive' | 'restore') {
    if (running.current) return;
    running.current = true;
    try {
      await (change === 'archive' ? archive : restore).mutateAsync({
        projectId: project.id,
        variables: undefined,
      });
      notify.success(t(change === 'archive' ? 'archiveConfirm.success' : 'restore.success'), project.name);
    } catch (error) {
      handleFailure(error);
    } finally {
      setConfirmingArchive(false);
      running.current = false;
    }
  }

  return (
    <>
      <Flex gap="small" wrap>
        {shown(actions.edit) ? (
          // A disabled button shows no tooltip of its own, so the reason sits on a wrapper the pointer can reach.
          <span title={actions.edit === 'disabled_archived' ? t('actions.archivedReason') : undefined}>
            <Button disabled={actions.edit !== 'enabled' || busy} onClick={() => setEditing(true)}>
              {t('actions.edit')}
            </Button>
          </span>
        ) : null}
        {shown(actions.archive) ? (
          <Button danger disabled={busy} onClick={() => setConfirmingArchive(true)}>
            {t('actions.archive')}
          </Button>
        ) : null}
        {shown(actions.restore) ? (
          <Button
            type="primary"
            loading={restore.isPending}
            disabled={busy}
            onClick={() => void run('restore')}
          >
            {t('actions.restore')}
          </Button>
        ) : null}
      </Flex>

      {actions.edit === 'enabled' ? (
        <EditProjectModal project={project} open={editing} onClose={() => setEditing(false)} />
      ) : null}
      {actions.archive === 'enabled' ? (
        <Modal
          open={confirmingArchive}
          title={t('archiveConfirm.title')}
          okText={t('archiveConfirm.confirm')}
          cancelText={t('archiveConfirm.cancel')}
          okButtonProps={{ danger: true }}
          onOk={() => void run('archive')}
          onCancel={() => setConfirmingArchive(false)}
          confirmLoading={archive.isPending}
          cancelButtonProps={{ disabled: archive.isPending }}
          closable={!archive.isPending}
          keyboard={!archive.isPending}
          maskClosable={false}
          destroyOnHidden
        >
          {t('archiveConfirm.body')}
        </Modal>
      ) : null}
    </>
  );
}
