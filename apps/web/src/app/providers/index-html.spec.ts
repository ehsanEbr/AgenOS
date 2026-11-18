import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { theme } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES } from '../../shared/i18n/locales';
import { browserPrefers } from '../../test/browser-language';
import { designTokens } from '../../shared/theme/theme';
import { UI_PREFERENCES_STORAGE_KEY } from '../state/ui-preferences.store';

const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');

/** Runs the inline script of index.html in the current jsdom document, as the browser does before React loads. */
function runInlineScript() {
  const source = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error('index.html has no inline script');
  new Function(source)();
}

/**
 * Storage with nothing in it. The test setup clears storage and then resets the preferences store, and the store's persistence writes
 * its state back (English, light), so a test that means "nothing saved" must clear it again, and checks that it did.
 */
function emptyStorage() {
  window.localStorage.clear();
  expect(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY)).toBeNull();
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

  it.each(['fa-IR', 'de-DE'])(
    'with nothing saved it leaves the page English and left to right, whatever the browser prefers (%s)',
    (tag) => {
      browserPrefers([tag, 'en-US']);
      emptyStorage();
      runInlineScript();
      const root = document.documentElement;
      expect(root.lang).toBe('en');
      expect(root.getAttribute('dir') ?? 'ltr').toBe('ltr');
    },
  );

  it('a saved English choice keeps the page English and left to right', () => {
    browserPrefers(['fa-IR']);
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ state: { themeMode: 'light', locale: 'en' }, version: 1 }),
    );
    runInlineScript();
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.getAttribute('dir') ?? 'ltr').toBe('ltr');
  });

  // The script and the application must agree, or the page would paint in one language and then switch. For every stored value below
  // the language and direction the script leaves on <html> are those of the language the real preferences store starts with.
  it.each([
    ['nothing saved', null],
    ['corrupt storage', '{not json'],
    ['a saved Persian choice', JSON.stringify({ state: { locale: 'fa' }, version: 1 })],
    ['a saved English choice', JSON.stringify({ state: { locale: 'en' }, version: 1 })],
    ['a saved choice with no language', JSON.stringify({ state: { themeMode: 'dark' }, version: 1 })],
    ['an unknown language', JSON.stringify({ state: { locale: 'xx' }, version: 1 })],
    ['a language in the wrong case', JSON.stringify({ state: { locale: 'FA' }, version: 1 })],
    ['a language of the wrong type', JSON.stringify({ state: { locale: 42 }, version: 1 })],
    ['a saved Persian choice with no version', JSON.stringify({ state: { locale: 'fa' } })],
    [
      'a saved Persian choice with a non-numeric version',
      JSON.stringify({ state: { locale: 'fa' }, version: '1' }),
    ],
  ])('agrees with the preferences store (%s), also in a Persian browser', async (_, saved) => {
    browserPrefers(['fa-IR']);
    emptyStorage();
    if (saved !== null) window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, saved);

    runInlineScript();
    vi.resetModules();
    const { useUiPreferences } = await import('../state/ui-preferences.store');
    const runtime = LOCALES[useUiPreferences.getState().locale];

    expect(document.documentElement.lang).toBe(runtime.htmlLang);
    expect(document.documentElement.getAttribute('dir') ?? 'ltr').toBe(runtime.dir);
  });

  // KNOWN LIMITATION (ADR-0012 note 27). The script assumes the store's persist version (1). The store (Zustand persist) discards a
  // state saved under another NUMERIC version, because no `migrate` function is configured, and logs an error; the script does not look
  // at the version. Nothing in the application writes another version, so this needs a hand edit, a downgrade or a future change of the
  // store's version, and the test pins the behavior so that such a change cannot go unnoticed: whoever changes the version must change
  // the script and the store's migration together, and then this test with them.
  it.each([2, 0])(
    'known limitation: a Persian choice saved under persist version %i is applied by the script but discarded by the store',
    async (version) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      browserPrefers(['de-DE']);
      emptyStorage();
      window.localStorage.setItem(
        UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ state: { locale: 'fa' }, version }),
      );

      runInlineScript();
      expect(document.documentElement.lang).toBe('fa'); // the script paints Persian, right to left ...
      expect(document.documentElement.dir).toBe('rtl');

      vi.resetModules();
      const { useUiPreferences } = await import('../state/ui-preferences.store');
      expect(useUiPreferences.getState().locale).toBe('en'); // ... and the store starts in English
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("couldn't be migrated"));
    },
  );

  it('falls back to the system preference and does not throw on corrupt storage', () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, '{not json');
    expect(() => runInlineScript()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light'); // jsdom reports "prefers light"
  });
});
