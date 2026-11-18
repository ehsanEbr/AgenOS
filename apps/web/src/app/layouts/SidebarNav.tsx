import { Flex, Menu, Tag, type MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, matchPath, useLocation } from 'react-router';
import { NAV_ITEMS } from './navigation';

interface SidebarNavProps {
  /** Called after a link is chosen; the mobile drawer uses it to close itself. */
  onNavigate?: () => void;
}

/**
 * Primary navigation. Entries are real links (so they can be opened in a new tab and are announced as links), planned
 * product areas are disabled with a "Soon" tag, and the current section is marked with `aria-current="page"`.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const { t } = useTranslation('shell');
  const { pathname } = useLocation();

  /** Whether `item` is the current section: its own path, or (for the Projects redirect) the pages it leads to. */
  const isCurrent = (item: (typeof NAV_ITEMS)[number]) =>
    item.status === 'available' &&
    (matchPath({ path: item.to, end: item.to === '/' }, pathname) !== null ||
      (item.activeOn !== undefined && matchPath({ path: item.activeOn }, pathname) !== null));

  const selectedKey = NAV_ITEMS.find(isCurrent)?.key;

  const items: MenuProps['items'] = NAV_ITEMS.map((item) => {
    const label = t(`nav.items.${item.key}`);
    if (item.status === 'available') {
      return {
        key: item.key,
        icon: item.icon,
        label: (
          // The current section is announced with aria-current="page" (what NavLink would set, plus the pages a redirect leads to).
          <Link to={item.to} aria-current={isCurrent(item) ? 'page' : undefined}>
            {label}
          </Link>
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
