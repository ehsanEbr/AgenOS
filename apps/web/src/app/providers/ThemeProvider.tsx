import { App as AntApp, ConfigProvider, theme } from 'antd';
import { type ReactNode, useLayoutEffect, useMemo } from 'react';
import { useMediaQuery } from '../../shared/hooks/useMediaQuery';
import { ANTD_LOCALES } from '../../shared/i18n/antd-locales';
import { LOCALES } from '../../shared/i18n/locales';
import { buildAntdTheme, resolveTheme, type ResolvedTheme } from '../../shared/theme/theme';
import { useUiPreferences } from '../state/ui-preferences.store';

/**
 * Mirrors the active theme / language / direction onto the document, and exposes a few tokens as CSS variables for
 * global.css. Must render inside ConfigProvider so `theme.useToken()` sees the active algorithm.
 *
 * `useLayoutEffect` (not `useEffect`) so the attributes are set before the browser paints the change.
 */
function DocumentSync({ resolved }: { resolved: ResolvedTheme }) {
  const locale = useUiPreferences((s) => s.locale);
  const { token } = theme.useToken();
  const { htmlLang, dir, fontFamily } = LOCALES[locale];

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = htmlLang;
    root.dir = dir;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved; // native controls, scrollbars and form fields follow the theme
    root.style.setProperty('--app-bg', token.colorBgLayout);
    root.style.setProperty('--app-text', token.colorText);
    root.style.setProperty('--app-primary', token.colorPrimary);
    root.style.setProperty('--app-radius', `${token.borderRadius}px`);
    root.style.setProperty('--app-font-family', fontFamily);
  }, [htmlLang, dir, resolved, fontFamily, token]);

  return null;
}

/**
 * The single place where theme, language and direction reach Ant Design. Components never pass `direction` or
 * `locale` themselves: they render once and follow whatever this provider says.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const themeMode = useUiPreferences((s) => s.themeMode);
  const locale = useUiPreferences((s) => s.locale);
  const systemPrefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const resolved = resolveTheme(themeMode, systemPrefersDark);
  const { dir, fontFamily } = LOCALES[locale];
  const themeConfig = useMemo(
    () => buildAntdTheme(resolved, { fontFamily, reducedMotion }),
    [resolved, fontFamily, reducedMotion],
  );

  return (
    <ConfigProvider
      theme={themeConfig}
      direction={dir}
      locale={ANTD_LOCALES[locale]}
      form={{ colon: false, requiredMark: 'optional' }}
    >
      {/* `App` provides the context-aware message/notification/modal instances used by useNotify. */}
      <AntApp component={false}>
        <DocumentSync resolved={resolved} />
        {children}
      </AntApp>
    </ConfigProvider>
  );
}
