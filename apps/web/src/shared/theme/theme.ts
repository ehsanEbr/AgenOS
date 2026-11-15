import { theme as antd, type ThemeConfig } from 'antd';

/**
 * AgentOS visual language, expressed as Ant Design design tokens. This file is the only place colors, radii,
 * type scale, spacing unit and elevation are decided; components consume them through Ant Design (`theme.useToken()`
 * in code, `var(--ant-*)` CSS variables in stylesheets) instead of hard-coding values.
 *
 * It deliberately configures Ant Design rather than wrapping it: no custom Button/Card/Input layer.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

/** Seed tokens: Ant Design derives every other shade, state and size from these. */
export const designTokens = {
  // color
  colorPrimary: '#4f46e5',
  colorInfo: '#2563eb',
  colorSuccess: '#16a34a',
  colorWarning: '#d97706',
  colorError: '#dc2626',
  // borders and radii (derived radii: SM/LG/XS scale from this)
  borderRadius: 8,
  lineWidth: 1,
  // typography (font family is per locale, see shared/i18n/locales.ts)
  fontSize: 14,
  // spacing: Ant Design's padding/margin/size tokens are multiples of this unit (4 px grid)
  sizeUnit: 4,
  sizeStep: 4,
} as const;

/** Elevation: cards and inline surfaces (`boxShadow`) versus floating layers such as menus, popovers, drawers. */
const ELEVATION = {
  light: {
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.1)',
    boxShadowSecondary: '0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.08)',
  },
  dark: {
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.5)',
    boxShadowSecondary: '0 8px 24px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)',
  },
} as const;

export interface BuildThemeOptions {
  /** Font stack of the active locale. */
  fontFamily: string;
  /** Disable animation for users who asked for reduced motion. */
  reducedMotion?: boolean;
}

export function buildAntdTheme(
  resolved: ResolvedTheme,
  { fontFamily, reducedMotion = false }: BuildThemeOptions,
): ThemeConfig {
  const algorithm = resolved === 'dark' ? antd.darkAlgorithm : antd.defaultAlgorithm;
  // Read the algorithm's own container/layout colors so the shell follows the theme without hard-coded hex values.
  const derived = antd.getDesignToken({ algorithm, token: designTokens });

  return {
    algorithm,
    token: {
      ...designTokens,
      ...ELEVATION[resolved],
      fontFamily,
      motion: !reducedMotion,
    },
    components: {
      // Ant Design's default Layout is a dark navy sider/header in every theme; make the shell neutral instead.
      Layout: {
        headerBg: derived.colorBgContainer,
        headerColor: derived.colorText,
        headerHeight: 56,
        headerPadding: '0 16px',
        siderBg: derived.colorBgContainer,
        triggerBg: derived.colorBgContainer,
        triggerColor: derived.colorText,
        bodyBg: derived.colorBgLayout,
      },
    },
  };
}
