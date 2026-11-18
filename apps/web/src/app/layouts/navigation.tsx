import {
  ApiOutlined,
  CodeOutlined,
  DashboardOutlined,
  EyeOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  ProjectOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { AppResources } from '../i18n/resources';

export type NavItemKey = keyof AppResources['shell']['nav']['items'];

export interface NavItem {
  key: NavItemKey;
  to: string;
  icon: ReactNode;
  /**
   * `available`: a route exists and the entry is a link.
   * `planned`: the product area is on the roadmap; the entry is shown disabled so the shape of the platform is visible.
   * When a feature lands, add its routes and flip the status (a test fails if an available entry has no route).
   */
  status: 'available' | 'planned';
  /**
   * Further paths on which this entry is the current section, besides `to` (a route pattern). The Projects entry is a redirect, so the
   * pages it leads to live under `/organizations/:organizationId/projects`.
   */
  activeOn?: string;
}

/** Primary navigation, in display order (specification section 14.2). Labels live in the `shell` namespace. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'overview', to: '/', icon: <DashboardOutlined />, status: 'available' },
  {
    key: 'projects',
    to: '/projects',
    icon: <ProjectOutlined />,
    status: 'available',
    activeOn: '/organizations/:organizationId/projects/*',
  },
  { key: 'agents', to: '/agents', icon: <RobotOutlined />, status: 'planned' },
  { key: 'models', to: '/models', icon: <ExperimentOutlined />, status: 'planned' },
  { key: 'mcpGateway', to: '/mcp-gateway', icon: <ApiOutlined />, status: 'planned' },
  { key: 'softwareIntelligence', to: '/software-intelligence', icon: <CodeOutlined />, status: 'planned' },
  { key: 'executions', to: '/executions', icon: <PlayCircleOutlined />, status: 'planned' },
  { key: 'observability', to: '/observability', icon: <EyeOutlined />, status: 'planned' },
  { key: 'settings', to: '/settings', icon: <SettingOutlined />, status: 'planned' },
];
