import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { theme } from 'antd';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../shared/i18n/locales';
import { designTokens } from '../../shared/theme/theme';
import { UI_PREFERENCES_STORAGE_KEY } from '../state/ui-preferences.store';

const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');

/** Runs the inline script of index.html in the current jsdom document, as the browser does before React loads. */
function runInlineScript() {
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error('index.html has no inline script');
  new Function(source)();
}

describe('index.html pre-paint script', () => {
  it('reads the same storage key as the preferences store', () => {
    expect(html).toContain(`'${UI_PREFERENCES_STORAGE_KEY}'`);
  });

  it('uses the same layout background colors as the real light and dark themes', () => {
    const light = theme.getDesignToken({
      algorithm: theme.defaultAlgorithm,
      token: designTokens,
    }).colorBgLayout;
    const dark = theme.getDesignToken({ algorithm: theme.darkAlgorithm, token: designTokens }).colorBgLayout;
    expect(html.toLowerCase()).toContain(`'${light.toLowerCase()}'`);
    expect(html.toLowerCase()).toContain(`'${dark.toLowerCase()}'`);
  });

  it('applies a saved dark theme and Persian RTL before React renders', () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ state: { themeMode: 'dark', locale: 'fa' }, version: 1 }),
    );
    runInlineScript();
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(root.lang).toBe(LOCALES.fa.htmlLang);
    expect(root.dir).toBe(LOCALES.fa.dir);
  });

  it('falls back to the system preference and does not throw on corrupt storage', () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, '{not json');
    expect(() => runInlineScript()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light'); // jsdom reports "prefers light"
  });
});
