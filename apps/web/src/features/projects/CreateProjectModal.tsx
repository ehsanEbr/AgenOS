import type { Project } from '@agentos/contracts';
import { Alert, Form, Input, Modal } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/ui/useNotify';
import { descriptionProblem, nameProblem, slugProblem } from './form-rules';
import { useCreateProject, useWriteFailureHandler } from './mutations';
import { suggestSlug } from './slug';
import { useFieldRule } from './useFieldRule';

interface Values {
  name: string;
  slug: string;
  description?: string;
}

interface CreateProjectModalProps {
  /** The organization of the page (from the URL). The server validates it as a selector; it is not authority. */
  organizationId: string;
  open: boolean;
  onClose: () => void;
  /** Called with the new project once it exists. The caller decides where to go. */
  onCreated: (project: Project) => void;
}

/**
 * Creates a project in the organization of the page (ADR-0012 D2: creation is part of the list page, so it has no route of its own). The
 * name is checked with the contract's own rules before anything is sent, and the slug is suggested from it until the person edits the
 * slug. The slug cannot be changed afterwards, and the form says so.
 *
 * One request per submission, even if the form is submitted twice in the same tick. A taken slug and a validation failure are shown on
 * the field; a result that cannot be confirmed (network, timeout, 5xx) keeps the form open with a notice, because the project may exist:
 * the lists were refetched, and repeating the submission would answer with the taken slug rather than create a second project.
 */
export function CreateProjectModal({ organizationId, open, onClose, onCreated }: CreateProjectModalProps) {
  const { t } = useTranslation('projects');
  const rule = useFieldRule();
  const notify = useNotify();
  const create = useCreateProject();
  const handleFailure = useWriteFailureHandler({ organizationId });
  const [form] = Form.useForm<Values>();
  const [uncertain, setUncertain] = useState(false);
  const slugEdited = useRef(false);
  const sending = useRef(false);

  async function submit(values: Values) {
    if (sending.current) return;
    sending.current = true;
    setUncertain(false);
    try {
      const description = values.description?.trim();
      const project = await create.mutateAsync({
        organizationId,
        name: values.name.trim(),
        slug: values.slug,
        ...(description ? { description } : {}),
      });
      notify.success(t('create.success'), project.name);
      onClose();
      onCreated(project);
    } catch (error) {
      const failure = handleFailure(error);
      if (failure.kind === 'slug_taken') form.setFields([{ name: 'slug', errors: [t('fields.slugTaken')] }]);
      else if (failure.kind === 'validation')
        form.setFields(failure.fields.map((name) => ({ name, errors: [t('fields.invalid')] })));
      else if (failure.kind === 'uncertain') setUncertain(true);
      else if (failure.kind === 'access_changed' || failure.kind === 'archived') onClose();
    } finally {
      sending.current = false;
    }
  }

  const pending = create.isPending;
  return (
    <Modal
      open={open}
      title={t('create.title')}
      okText={t('create.submit')}
      cancelText={t('create.cancel')}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={pending}
      cancelButtonProps={{ disabled: pending }}
      closable={!pending}
      keyboard={!pending}
      maskClosable={false}
      destroyOnHidden
      // The form store belongs to this component, not to the modal: without a reset a cancelled form would reopen with its old values.
      afterClose={() => {
        form.resetFields();
        slugEdited.current = false;
        setUncertain(false);
      }}
    >
      <Form<Values>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => void submit(values)}
        onValuesChange={(changed) => {
          if ('slug' in changed) slugEdited.current = (changed.slug ?? '') !== '';
          // The slug follows the name until the person writes their own.
          if ('name' in changed && !slugEdited.current)
            form.setFieldValue('slug', suggestSlug(changed.name ?? ''));
        }}
      >
        {uncertain ? (
          <Alert type="warning" showIcon title={t('write.uncertainInline')} style={{ marginBlockEnd: 16 }} />
        ) : null}
        <Form.Item name="name" label={t('create.name')} rules={[rule(nameProblem)]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="slug"
          label={t('create.slug')}
          extra={t('create.slugHelp')}
          rules={[rule(slugProblem)]}
        >
          <Input autoComplete="off" spellCheck={false} />
        </Form.Item>
        <Form.Item name="description" label={t('create.description')} rules={[rule(descriptionProblem)]}>
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
