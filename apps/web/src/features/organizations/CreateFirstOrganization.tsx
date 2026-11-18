import { organizationNameSchema, type OrganizationWithRole } from '@agentos/contracts';
import { Button, Card, Flex, Form, Input, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { isApiClientError } from '../../shared/api/errors';
import { useNotify } from '../../shared/ui/useNotify';
import { useCreateOrganization } from './queries';

const NAME_MAX_LENGTH = 100;

interface Values {
  name: string;
}

interface CreateFirstOrganizationProps {
  /** Called with the new organization once it exists. The caller decides where to go (this feature does not know the project routes). */
  onCreated: (organization: OrganizationWithRole) => void;
}

/**
 * The "first organization" flow: a user with no organization names one and becomes its owner. The name is checked with the contract's
 * own rule before anything is sent; a refusal by the server is shown on the field it names, anything else as a notification.
 */
export function CreateFirstOrganization({ onCreated }: CreateFirstOrganizationProps) {
  const { t } = useTranslation('organizations');
  const notify = useNotify();
  const create = useCreateOrganization();
  const [form] = Form.useForm<Values>();

  async function submit(values: Values) {
    if (create.isPending) return;
    try {
      onCreated(await create.mutateAsync({ name: values.name }));
    } catch (error) {
      if (isApiClientError(error) && error.kind === 'http' && error.code === 'validation_error') {
        form.setFields([{ name: 'name', errors: [t('fields.invalid')] }]);
      } else notify.error(error);
    }
  }

  return (
    <Card style={{ inlineSize: '100%', maxInlineSize: 480 }}>
      <Flex vertical gap="middle">
        <div>
          <Typography.Title level={1} style={{ marginBlock: 0, fontSize: 24 }}>
            {t('createFirst.title')}
          </Typography.Title>
          <Typography.Paragraph type="secondary">{t('createFirst.description')}</Typography.Paragraph>
        </div>
        <Form<Values> form={form} layout="vertical" requiredMark={false} onFinish={(v) => void submit(v)}>
          <Form.Item
            name="name"
            label={t('createFirst.name')}
            rules={[
              {
                validator: async (_, value: unknown) => {
                  const text = typeof value === 'string' ? value : '';
                  if (text.trim() === '') throw new Error(t('fields.nameRequired'));
                  if (!organizationNameSchema.safeParse(text).success)
                    throw new Error(t('fields.nameTooLong', { max: NAME_MAX_LENGTH }));
                },
              },
            ]}
          >
            <Input autoComplete="organization" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={create.isPending}>
            {t('createFirst.submit')}
          </Button>
        </Form>
      </Flex>
    </Card>
  );
}
