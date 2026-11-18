import { Alert, Button, Flex, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router';
import { AuthCard } from '../AuthCard';
import { FailureAlert } from '../FailureAlert';
import { classifyAuthFailure, emailProblem, presentedPasswordProblem, type AuthFailure } from '../form-rules';
import { afterSignInTarget, readAuthNavigationState } from '../navigation-state';
import { useFieldRule } from '../useFieldRule';
import { useSession, useSignIn } from '../use-session';

interface Values {
  email: string;
  password: string;
}

/** Sign-in. It reads the same session entry as the rest of the app: someone who is already signed in is sent on, never shown the form. */
export function SignInPage() {
  const { t } = useTranslation('auth');
  const rule = useFieldRule();
  const location = useLocation();
  const session = useSession();
  const signIn = useSignIn();
  const [form] = Form.useForm<Values>();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const hint = readAuthNavigationState(location.state);

  if (session.value.status === 'authenticated') return <Navigate to={afterSignInTarget(hint.from)} replace />;

  async function submit(values: Values) {
    if (signIn.isPending) return;
    setFailure(null);
    try {
      await signIn.mutateAsync({ email: values.email, password: values.password });
    } catch (error) {
      const found = classifyAuthFailure(error);
      const fields =
        found.kind === 'validation'
          ? found.fields.filter((name): name is 'email' | 'password' => name !== 'displayName')
          : [];
      if (fields.length > 0) form.setFields(fields.map((name) => ({ name, errors: [t('fields.invalid')] })));
      else setFailure(found);
    }
  }

  return (
    <AuthCard title={t('signIn.title')} description={t('signIn.description')}>
      {hint.registered ? <Alert type="success" showIcon title={t('signIn.registered')} /> : null}
      {hint.ended ? <Alert type="info" showIcon title={t('signIn.ended')} /> : null}
      {failure ? <FailureAlert failure={failure} /> : null}

      <Form<Values>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ email: hint.email ?? '' }}
        onFinish={(values) => void submit(values)}
      >
        <Form.Item name="email" label={t('signIn.email')} rules={[rule(emailProblem)]}>
          <Input type="email" autoComplete="username" inputMode="email" />
        </Form.Item>
        <Form.Item name="password" label={t('signIn.password')} rules={[rule(presentedPasswordProblem)]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={signIn.isPending}>
          {t('signIn.submit')}
        </Button>
      </Form>

      <Flex gap="small" justify="center" wrap>
        <Typography.Text type="secondary">{t('signIn.noAccount')}</Typography.Text>
        <Link to="/sign-up">{t('signIn.toSignUp')}</Link>
      </Flex>
    </AuthCard>
  );
}
