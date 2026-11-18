import { MenuOutlined } from '@ant-design/icons';
import { Button, Drawer, Flex, Layout, Typography, theme } from 'antd';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useParams } from 'react-router';
import { UserMenu } from '../../features/auth';
import { ApiStatus } from '../../features/health';
import { OrganizationSwitcher } from '../../features/organizations';
import { useMediaQuery } from '../../shared/hooks/useMediaQuery';
import { LOCALES } from '../../shared/i18n/locales';
import { organizationProjectsPath } from '../router/paths';
import { useUiPreferences } from '../state/ui-preferences.store';
import { NavigationProgress } from './NavigationProgress';
import { PreferenceControls } from './PreferenceControls';
import { SidebarNav } from './SidebarNav';
import { useRouteAnnouncement } from './useRouteAnnouncement';

const SIDEBAR_WIDTH = 248;
const SIDEBAR_COLLAPSED_WIDTH = 64;

/**
 * The persistent application frame: navigation, header and the content region that every route renders into.
 *
 * - One layout for every language and theme. Direction comes from the ThemeProvider, and all spacing here uses logical
 *   properties, so right-to-left needs no second layout.
 * - Wide screens get a collapsible sidebar; narrow screens get the same navigation in a drawer opened from the header.
 * - Landmarks: `<aside>` + `<nav>` (navigation), `<header>`, `<main id="main-content">`. A skip link jumps past the navigation.
 *
 * Route guards (authentication, permissions) belong around this component in the route table, not inside it: `RequireAuth` wraps it.
 */
export function AppShell() {
  const { t } = useTranslation('shell');
  const { token } = theme.useToken();
  const { organizationId } = useParams(); // the organization of the page, from the URL (ADR-0012 D2)
  const locale = useUiPreferences((s) => s.locale);
  const collapsed = useUiPreferences((s) => s.sidebarCollapsed);
  const setCollapsed = useUiPreferences((s) => s.setSidebarCollapsed);

  const isWide = useMediaQuery(`(min-width: ${token.screenLG}px)`);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useRouteAnnouncement(mainRef);

  const brand = (
    <Link to="/" style={{ color: 'inherit' }}>
      <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
        {isWide && collapsed ? 'A' : t('brand')}
      </Typography.Text>
    </Link>
  );

  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <a className="skip-link" href="#main-content">
        {t('skipToContent')}
      </a>
      <NavigationProgress />

      {isWide ? (
        <Layout.Sider
          theme="light" // colors come from the Layout tokens in shared/theme, which follow light/dark
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          width={SIDEBAR_WIDTH}
          collapsedWidth={SIDEBAR_COLLAPSED_WIDTH}
          style={{ position: 'sticky', insetBlockStart: 0, blockSize: '100vh', overflow: 'auto' }}
        >
          <Flex align="center" style={{ blockSize: 56, paddingInline: token.padding }}>
            {brand}
          </Flex>
          <SidebarNav />
        </Layout.Sider>
      ) : (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          // The drawer opens from the inline-start edge: left for LTR, right for RTL.
          placement={LOCALES[locale].dir === 'rtl' ? 'right' : 'left'}
          size={SIDEBAR_WIDTH}
          title={brand}
          styles={{ body: { padding: 0 } }}
        >
          <SidebarNav onNavigate={() => setDrawerOpen(false)} />
        </Drawer>
      )}

      <Layout>
        <Layout.Header>
          <Flex align="center" justify="space-between" gap="middle" style={{ blockSize: '100%' }}>
            <Flex align="center" gap="small">
              {isWide ? null : (
                <Button
                  type="text"
                  icon={<MenuOutlined />}
                  aria-label={t('nav.open')}
                  aria-expanded={drawerOpen}
                  onClick={() => setDrawerOpen(true)}
                />
              )}
              <OrganizationSwitcher
                currentOrganizationId={organizationId}
                pathFor={organizationProjectsPath}
              />
            </Flex>
            <Flex align="center" gap="middle" wrap>
              <ApiStatus />
              <PreferenceControls />
              <UserMenu />
            </Flex>
          </Flex>
        </Layout.Header>

        <Layout.Content id="main-content" tabIndex={-1} ref={mainRef} style={{ padding: token.paddingLG }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
