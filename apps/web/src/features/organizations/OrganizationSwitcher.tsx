import { DownOutlined } from '@ant-design/icons';
import { Button, Dropdown, type MenuProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { loadedOrganizations, useOrganization, useOrganizationList } from './queries';

interface OrganizationSwitcherProps {
  /** The organization of the page being shown (from the URL), if the page belongs to one. */
  currentOrganizationId: string | undefined;
  /** Where choosing an organization leads. The caller supplies it: this feature does not know the project routes. */
  pathFor: (organizationId: string) => string;
}

/**
 * The organization switcher of the shell (ADR-0012 D2, D5). Switching is a navigation: every choice is a link to the other
 * organization's page, so nothing of the previous organization is reinterpreted under the new one. The current organization is the
 * one in the URL (its name comes from `GET /organizations/:id`), never a stored value. The list is fetched only when the menu is
 * opened, 100 per request with "load more", and says how many of the total it shows.
 */
export function OrganizationSwitcher({ currentOrganizationId, pathFor }: OrganizationSwitcherProps) {
  const { t } = useTranslation('organizations');
  const [open, setOpen] = useState(false);
  const current = useOrganization(currentOrganizationId);
  const list = useOrganizationList({ enabled: open });
  const { organizations, total } = loadedOrganizations(list.data);

  const items: MenuProps['items'] = [];
  if (list.isPending) {
    items.push({ key: 'loading', label: t('switcher.loading'), disabled: true });
  } else if (list.isError) {
    items.push(
      { key: 'failed', label: t('switcher.failed'), disabled: true },
      { key: 'retry', label: t('switcher.retry'), onClick: () => void list.refetch() },
    );
  } else if (organizations.length === 0) {
    items.push({ key: 'empty', label: t('switcher.empty'), disabled: true });
  } else {
    for (const organization of organizations) {
      items.push({
        key: organization.id,
        label: <Link to={pathFor(organization.id)}>{organization.name}</Link>,
      });
    }
    items.push({ type: 'divider' });
    items.push({
      key: 'showing',
      label: t('switcher.showing', { loaded: organizations.length, total }),
      disabled: true,
    });
    if (list.hasNextPage)
      items.push({
        key: 'more',
        label: t('switcher.loadMore'),
        disabled: list.isFetchingNextPage,
        // Keeps the menu open: choosing "load more" is not choosing an organization.
        onClick: () => void list.fetchNextPage(),
      });
  }

  return (
    <Dropdown
      trigger={['click']}
      open={open}
      // A click on a menu item is handled by the item's own `onClick` below (choosing an organization closes the menu, "load more" and
      // "try again" do not), so the dropdown's own close-on-select is ignored.
      onOpenChange={(next, info) => {
        if (info.source !== 'menu') setOpen(next);
      }}
      menu={{
        items,
        selectedKeys: currentOrganizationId ? [currentOrganizationId] : [],
        onClick: ({ key }) => {
          if (key !== 'more' && key !== 'retry') setOpen(false);
        },
        'aria-label': t('switcher.menuLabel'),
      }}
    >
      <Button
        aria-label={current.data ? t('switcher.current', { name: current.data.name }) : t('switcher.choose')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {current.data?.name ?? t('switcher.choose')} <DownOutlined />
      </Button>
    </Dropdown>
  );
}
