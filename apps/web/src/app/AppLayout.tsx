import { DashboardOutlined } from '@ant-design/icons';
import { Layout, Menu, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';

// Navigation grows with the product (spec section 14.2); only implemented areas are listed.
const NAV_ITEMS = [{ key: '/', icon: <DashboardOutlined />, label: 'Overview' }];

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} theme="light">
        <Typography.Title level={4} style={{ margin: 16 }}>
          AgentOS
        </Typography.Title>
        <Menu
          mode="inline"
          selectedKeys={[pathname]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Content style={{ padding: 24, maxWidth: 960, width: '100%' }}>
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
