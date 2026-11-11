import { LockOutlined } from '@ant-design/icons';
import { Result } from 'antd';
import type { ReactNode } from 'react';
import { useAuthStore } from './auth.store';

/**
 * The single place that gates the application behind authentication.
 * Phase 1 has no identity provider, so the default mode lets everyone through; flipping
 * `VITE_AUTH_MODE=required` makes the boundary fail closed until Phase 2 supplies sessions.
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const { mode, status } = useAuthStore();

  if (mode === 'required' && status !== 'authenticated') {
    return (
      <Result
        icon={<LockOutlined />}
        title="Sign-in required"
        subTitle="Authentication is not available yet. It arrives with the Identity phase."
      />
    );
  }
  return <>{children}</>;
}
