import { Button, Flex, Form, Input, Result, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router';
import { AuthCard } from '../AuthCard';
import { FailureAlert } from '../FailureAlert';
import {
  PASSWORD_MIN_LENGTH,
  classifyAuthFailure,
  displayNameProblem,
  emailProblem,
  newPasswordProblem,
  type AuthFailure,
} from '../form-rules';
import { DEFAULT_AFTER_SIGN_IN, type AuthNavigationState } from '../navigation-state';
import { useFieldRule } from '../useFieldRule';
import { useSession, useSignUp } from '../use-session';

interface Values {
  email: string;
  displayName: string;
  password: string;
}

/**
 * Sign-up. The API creates the account and does NOT sign the user in, so on success the user continues on the sign-in page (with a
 * notice and the email filled in). When the operator has closed registration the API answers `403 registration_closed` and the page
 * says so plainly instead of showing a form that cannot work.
 */
export function SignUpPage() {
  const { t } = useTranslation('auth');
  const rule = useFieldRule();
  const navigate = useNavigate();
  const session = useSession();
  const signUp = useSignUp();
  const [form] = Form.useForm<Values>();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  // Whether this page is still on screen. Its request outlives it (the user may leave while it runs): the result is then not this
  // page's to act on, and must not move the user away from whatever they are looking at now.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  if (session.value.status === 'authenticated') return <Navigate to={DEFAULT_AFTER_SIGN_IN} replace />;

  if (failure?.kind === 'registration_closed')
    return (
      <AuthCard title={t('signUp.closed.title')}>
        <Result
          status="info"
          subTitle={t('signUp.closed.description')}
          extra={
            <Link to="/sign-in">
              <Button type="primary">{t('signUp.toSignIn')}</Button>
            </Link>
          }
        />
      </AuthCard>
    );

  async function submit(values: Values) {
    if (signUp.isPending) return;
    setFailure(null);
    try {
      await signUp.mutateAsync({
        email: values.email,
        displayName: values.displayName,
        password: values.password,
      });
      if (!onScreen.current) return;
      const state: AuthNavigationState = { registered: true, email: values.email.trim() };
      void navigate('/sign-in', { replace: true, state });
    } catch (error) {
      const found = classifyAuthFailure(error);
      if (found.kind === 'email_taken') {
        form.setFields([{ name: 'email', errors: [t('fields.emailTaken')] }]);
      } else if (found.kind === 'validation' && found.fields.length > 0) {
        form.setFields(found.fields.map((name) => ({ name, errors: [t('fields.invalid')] })));
      } else setFailure(found);
    }
  }

  return (
    <AuthCard title={t('signUp.title')} description={t('signUp.description')}>
      {failure ? <FailureAlert failure={failure} /> : null}

      <Form<Values>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => void submit(values)}
      >
        <Form.Item name="email" label={t('signUp.email')} rules={[rule(emailProblem)]}>
          <Input type="email" autoComplete="email" inputMode="email" />
        </Form.Item>
        <Form.Item name="displayName" label={t('signUp.displayName')} rules={[rule(displayNameProblem)]}>
          <Input autoComplete="name" />
        </Form.Item>
        <Form.Item
          name="password"
          label={t('signUp.password')}
          extra={t('signUp.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          rules={[rule(newPasswordProblem)]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={signUp.isPending}>
          {t('signUp.submit')}
        </Button>
      </Form>

      <Flex gap="small" justify="center" wrap>
        <Typography.Text type="secondary">{t('signUp.haveAccount')}</Typography.Text>
        <Link to="/sign-in">{t('signUp.toSignIn')}</Link>
      </Flex>
    </AuthCard>
  );
}
