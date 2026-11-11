import { HomeOutlined } from '@ant-design/icons';
import { Layout, Menu, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ApiStatus } from '../features/health/ApiStatus';
import { useUiStore } from '../shared/stores/ui.store';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';

// Navigation grows with the product (spec section 14.2); only implemented areas are listed.
const NAV_ITEMS = [{ key: '/', icon: <HomeOutlined />, label: 'Home' }];

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { siderCollapsed, setSiderCollapsed } = useUiStore();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        collapsible
        collapsed={siderCollapsed}
        onCollapse={setSiderCollapsed}
        breakpoint="lg"
        theme="light"
      >
        <Typography.Title level={4} style={{ margin: 16 }}>
          {siderCollapsed ? 'A' : 'AgentOS'}
        </Typography.Title>
        <Menu
          mode="inline"
          selectedKeys={[pathname]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            background: 'transparent',
          }}
        >
          <ApiStatus />
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
