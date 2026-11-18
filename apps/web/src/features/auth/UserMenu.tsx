import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSignOut } from './sign-out';
import { useCurrentUser } from './use-session';

/**
 * The signed-in user in the application header: their name, and a menu with the account and the sign-out action. It renders
 * nothing unless a user is signed in. Signing out is the sign-out flow of ADR-0012 D4 rule 6 (uncertain outcomes are handled there:
 * the private UI disappears and the guard shows the "sign-out is not complete" screen).
 */
export function UserMenu() {
  const { t } = useTranslation('auth');
  const user = useCurrentUser();
  const signOut = useSignOut();
  if (!user) return null;

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: [
          { key: 'account', label: t('userMenu.signedInAs', { email: user.email }), disabled: true },
          { type: 'divider' },
          {
            key: 'sign-out',
            icon: <LogoutOutlined />,
            label: t('userMenu.signOut'),
            disabled: signOut.isPending,
            onClick: () => signOut.mutate(),
          },
        ],
      }}
    >
      <Button
        type="text"
        icon={<UserOutlined />}
        aria-label={t('userMenu.label')}
        loading={signOut.isPending}
      >
        <span
          style={{ maxInlineSize: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {user.displayName}
        </span>
      </Button>
    </Dropdown>
  );
}
