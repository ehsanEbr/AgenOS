import { Flex, Layout, Typography, theme } from 'antd';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet } from 'react-router';
import { PreferenceControls } from './PreferenceControls';
import { useRouteAnnouncement } from './useRouteAnnouncement';

/**
 * The frame of the public pages (sign-in, sign-up): no navigation and nothing private, but the same landmarks, skip link, document
 * title and focus handling as the shell, and the language and theme controls so a Persian speaker can switch before signing in.
 */
export function PublicLayout() {
  const { t } = useTranslation('shell');
  const { token } = theme.useToken();
  const mainRef = useRef<HTMLElement>(null);
  useRouteAnnouncement(mainRef);

  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <a className="skip-link" href="#main-content">
        {t('skipToContent')}
      </a>
      <Layout.Header>
        <Flex align="center" justify="space-between" gap="middle" style={{ blockSize: '100%' }}>
          <Link to="/" style={{ color: 'inherit' }}>
            <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
              {t('brand')}
            </Typography.Text>
          </Link>
          <PreferenceControls />
        </Flex>
      </Layout.Header>
      <Layout.Content
        id="main-content"
        tabIndex={-1}
        ref={mainRef}
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: token.paddingLG,
        }}
      >
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
