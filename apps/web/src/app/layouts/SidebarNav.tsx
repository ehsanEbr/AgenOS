import { Flex, Menu, Tag, type MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import { NavLink, matchPath, useLocation } from 'react-router';
import { NAV_ITEMS } from './navigation';

interface SidebarNavProps {
  /** Called after a link is chosen; the mobile drawer uses it to close itself. */
  onNavigate?: () => void;
}

/**
 * Primary navigation. Entries are real links (so they can be opened in a new tab and are announced as links), planned
 * product areas are disabled with a "Soon" tag, and the current page is marked with `aria-current="page"` by NavLink.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const { t } = useTranslation('shell');
  const { pathname } = useLocation();

  const selectedKey = NAV_ITEMS.find(
    (item) => item.status === 'available' && matchPath({ path: item.to, end: item.to === '/' }, pathname),
  )?.key;

  const items: MenuProps['items'] = NAV_ITEMS.map((item) => {
    const label = t(`nav.items.${item.key}`);
    if (item.status === 'available') {
      return {
        key: item.key,
        icon: item.icon,
        label: (
          // NavLink sets aria-current="page" on the active link, which assistive technology announces.
          <NavLink to={item.to} end={item.to === '/'}>
            {label}
          </NavLink>
        ),
      };
    }
    return {
      key: item.key,
      icon: item.icon,
      disabled: true,
      title: t('nav.plannedHint'),
      label: (
        <Flex align="center" justify="space-between" gap="small">
          {/* Long names truncate instead of squeezing the tag (min-inline-size lets a flex child shrink). */}
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: 0 }}
          >
            {label}
          </span>
          <Tag variant="filled" style={{ flexShrink: 0, marginInlineEnd: 0 }}>
            {t('nav.planned')}
          </Tag>
        </Flex>
      ),
    };
  });

  return (
    <nav aria-label={t('nav.label')}>
      <Menu
        mode="inline"
        items={items}
        selectedKeys={selectedKey ? [selectedKey] : []}
        onClick={onNavigate}
        style={{ borderInlineEnd: 0, background: 'transparent' }}
      />
    </nav>
  );
}
