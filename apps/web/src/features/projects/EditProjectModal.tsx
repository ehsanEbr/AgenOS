import type { Project, UpdateProjectRequest } from '@agentos/contracts';
import { Alert, Form, Input, Modal } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import { descriptionProblem, nameProblem } from './form-rules';
import { useUpdateProject, useWriteFailureHandler } from './mutations';
import { useFieldRule } from './useFieldRule';

interface Values {
  name: string;
  description?: string;
}

interface EditProjectModalProps {
  project: Project;
  open: boolean;
  onClose: () => void;
}

/**
 * Edits the name and the description of a project: the only two fields the API lets change (the slug and the organization are
 * immutable, so the form does not offer them). Only what changed is sent, and a submission that changes nothing sends nothing. A blank
 * description removes it (`null`, as the contract defines). The caller offers this only for an active project; if the project was
 * archived meanwhile the server answers `409 project_archived` and the form closes after the project has been refetched.
 */
export function EditProjectModal({ project, open, onClose }: EditProjectModalProps) {
  const { t } = useTranslation('projects');
  const rule = useFieldRule();
  const notify = useNotify();
  const update = useUpdateProject();
  const handleFailure = useWriteFailureHandler({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const [form] = Form.useForm<Values>();
  const [uncertain, setUncertain] = useState(false);
  const sending = useRef(false);

  async function submit(values: Values) {
    if (sending.current) return;
    const name = values.name.trim();
    const description = (values.description ?? '').trim();
    const changes: UpdateProjectRequest = {
      ...(name !== project.name ? { name } : {}),
      ...(description !== (project.description ?? '')
        ? { description: description === '' ? null : description }
        : {}),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }

    sending.current = true;
    setUncertain(false);
    try {
      await update.mutateAsync({ projectId: project.id, variables: changes });
      notify.success(t('edit.success'));
      onClose();
    } catch (error) {
      const failure = handleFailure(error);
      if (failure.kind === 'validation')
        form.setFields(
          failure.fields
            .filter((field): field is 'name' | 'description' => field !== 'slug') // the slug is not on this form
            .map((field) => ({ name: field, errors: [t('fields.invalid')] })),
        );
      else if (failure.kind === 'uncertain') setUncertain(true);
      else if (failure.kind === 'access_changed' || failure.kind === 'archived') onClose();
    } finally {
      sending.current = false;
    }
  }

  const pending = update.isPending;
  return (
    <Modal
      open={open}
      title={t('edit.title')}
      okText={t('edit.submit')}
      cancelText={t('edit.cancel')}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={pending}
      cancelButtonProps={{ disabled: pending }}
      closable={!pending}
      keyboard={!pending}
      maskClosable={false}
      destroyOnHidden
      // The form store belongs to this component, not to the modal: reopening starts from the project's current values again.
      afterClose={() => {
        form.resetFields();
        setUncertain(false);
      }}
    >
      <Form<Values>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ name: project.name, description: project.description ?? '' }}
        onFinish={(values) => void submit(values)}
      >
        {uncertain ? (
          <Alert type="warning" showIcon title={t('write.uncertainInline')} style={{ marginBlockEnd: 16 }} />
        ) : null}
        <Form.Item name="name" label={t('create.name')} rules={[rule(nameProblem)]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="description" label={t('create.description')} rules={[rule(descriptionProblem)]}>
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
