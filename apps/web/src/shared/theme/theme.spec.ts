import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../i18n/locales';
import { buildAntdTheme, designTokens, resolveTheme } from './theme';

const options = { fontFamily: LOCALES.en.fontFamily };

describe('resolveTheme', () => {
  it('uses an explicit choice as is', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the operating system in "system" mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('buildAntdTheme', () => {
  it('selects the matching Ant Design algorithm', () => {
    expect(buildAntdTheme('light', options).algorithm).toBe(theme.defaultAlgorithm);
    expect(buildAntdTheme('dark', options).algorithm).toBe(theme.darkAlgorithm);
  });

  it('carries the design tokens and the locale font', () => {
    const config = buildAntdTheme('light', { fontFamily: LOCALES.fa.fontFamily });
    expect(config.token).toMatchObject({ colorPrimary: designTokens.colorPrimary, borderRadius: 8 });
    expect(config.token?.fontFamily).toBe(LOCALES.fa.fontFamily);
  });

  it('uses a stronger elevation shadow in the dark theme', () => {
    const light = buildAntdTheme('light', options).token?.boxShadow;
    const dark = buildAntdTheme('dark', options).token?.boxShadow;
    expect(light).not.toBe(dark);
  });

  it('turns animation off for users who prefer reduced motion', () => {
    expect(buildAntdTheme('light', options).token?.motion).toBe(true);
    expect(buildAntdTheme('light', { ...options, reducedMotion: true }).token?.motion).toBe(false);
  });

  it('makes the shell follow the theme (no hard-coded navy header/sider)', () => {
    const light = buildAntdTheme('light', options).components?.Layout;
    const dark = buildAntdTheme('dark', options).components?.Layout;
    expect(light?.headerBg).not.toBe(dark?.headerBg);
    expect(light?.siderBg).toBe(light?.headerBg);
  });
});
