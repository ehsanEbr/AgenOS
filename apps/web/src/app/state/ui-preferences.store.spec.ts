import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPrefers } from '../../test/browser-language';
import { UI_PREFERENCES_STORAGE_KEY, defaultPreferences, useUiPreferences } from './ui-preferences.store';

function stored() {
  const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown>; version: number }) : null;
}

async function rehydrate() {
  await useUiPreferences.persist.rehydrate();
  return useUiPreferences.getState();
}

describe('ui preferences store', () => {
  beforeEach(() => window.localStorage.clear());

  it('persists changes (only the preferences, not the setter functions)', () => {
    useUiPreferences.getState().setThemeMode('dark');
    useUiPreferences.getState().setLocale('fa');
    useUiPreferences.getState().setSidebarCollapsed(true);

    expect(stored()).toEqual({
      state: { themeMode: 'dark', locale: 'fa', sidebarCollapsed: true, lastOrganizationId: null },
      version: 1,
    });
  });

  it('restores saved preferences on startup', async () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ state: { themeMode: 'dark', locale: 'fa', sidebarCollapsed: true }, version: 1 }),
    );
    expect(await rehydrate()).toMatchObject({ themeMode: 'dark', locale: 'fa', sidebarCollapsed: true });
  });

  it('replaces invalid saved values one by one instead of discarding or trusting everything', async () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ state: { themeMode: 'neon', locale: 'fa', sidebarCollapsed: 'yes' }, version: 1 }),
    );
    expect(await rehydrate()).toMatchObject({ themeMode: 'system', locale: 'fa', sidebarCollapsed: false });
  });

  it('survives corrupted storage', async () => {
    useUiPreferences.setState(defaultPreferences());
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, '{definitely not json');
    const state = await rehydrate();
    expect(state.themeMode).toBe('system');
    expect(state.locale).toBe('en');
  });

  it('keeps working when localStorage is unavailable (private mode, blocked storage)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => useUiPreferences.getState().setThemeMode('dark')).not.toThrow();
    await rehydrate();
    expect(useUiPreferences.getState().themeMode).toBe('dark'); // in-memory state still updates
  });
});

describe('the last-used organization (ADR-0012 D2)', () => {
  const ORGANIZATION = '3f2c9a1e-5b7d-4c80-9e14-6a2d8b0c7f55';
  beforeEach(() => window.localStorage.clear());

  it('starts empty, is set and cleared, and persists only the id', () => {
    useUiPreferences.setState(defaultPreferences());
    expect(useUiPreferences.getState().lastOrganizationId).toBeNull();

    useUiPreferences.getState().setLastOrganizationId(ORGANIZATION);
    expect(stored()?.state).toMatchObject({ lastOrganizationId: ORGANIZATION });

    useUiPreferences.getState().clearLastOrganization();
    expect(useUiPreferences.getState().lastOrganizationId).toBeNull();
    expect(stored()?.state).toMatchObject({ lastOrganizationId: null });
  });

  it('restores a saved id', async () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ state: { lastOrganizationId: ORGANIZATION }, version: 1 }),
    );
    expect((await rehydrate()).lastOrganizationId).toBe(ORGANIZATION);
  });

  it.each([['not-an-id'], [42], [{ id: ORGANIZATION }], [''], ['<script>alert(1)</script>']])(
    'drops stored data that is not an id (%j) instead of trusting it',
    async (garbage) => {
      useUiPreferences.setState(defaultPreferences());
      window.localStorage.setItem(
        UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ state: { lastOrganizationId: garbage }, version: 1 }),
      );
      expect((await rehydrate()).lastOrganizationId).toBeNull();
    },
  );
});

describe('defaultPreferences', () => {
  it.each([[['fa-IR', 'en-US']], [['fa']], [['de-DE', 'en-US']], [['de-DE', 'fr']], [[]]])(
    'is English whatever the browser prefers (%j): its language list is not consulted',
    (languages) => {
      browserPrefers(languages);
      expect(defaultPreferences().locale).toBe('en');
    },
  );

  it('follows the system theme and starts with an expanded sidebar', () => {
    expect(defaultPreferences()).toMatchObject({ themeMode: 'system', sidebarCollapsed: false });
  });
});

describe('the language when the store starts (a page load)', () => {
  beforeEach(() => window.localStorage.clear());

  /** A new store, as created when the application's module loads: the same code path as a page load. */
  async function freshStore() {
    vi.resetModules();
    const { useUiPreferences: fresh } = await import('./ui-preferences.store');
    return fresh.getState();
  }
  const save = (state: Record<string, unknown>) =>
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({ state, version: 1 }));
  const browser = browserPrefers;

  it.each([
    ['a Persian browser', ['fa-IR', 'en-US']],
    ['a German browser', ['de-DE', 'en-US']],
    ['a browser with no language list', []],
  ])('with nothing saved, %s starts in English', async (_, languages) => {
    browser(languages);
    expect((await freshStore()).locale).toBe('en');
  });

  it('English stays the default when something else is saved but no language (the theme only)', async () => {
    browser(['fa-IR']);
    save({ themeMode: 'dark' });
    expect(await freshStore()).toMatchObject({ locale: 'en', themeMode: 'dark' });
  });

  it('a saved Persian choice wins over the browser, whichever language the browser prefers', async () => {
    browser(['de-DE']);
    save({ locale: 'fa' });
    expect((await freshStore()).locale).toBe('fa');

    browser(['fa-IR']);
    expect((await freshStore()).locale).toBe('fa');
  });

  it('a saved English choice wins over a Persian browser', async () => {
    browser(['fa-IR']);
    save({ locale: 'en' });
    expect((await freshStore()).locale).toBe('en');
  });

  it('an unknown saved language is not trusted: English', async () => {
    browser(['fa-IR']);
    save({ locale: 'xx' });
    expect((await freshStore()).locale).toBe('en');
  });

  it('a language chosen by the user is saved, and is what the next page load starts with', async () => {
    browser(['de-DE']);
    useUiPreferences.getState().setLocale('fa');
    expect(stored()?.state).toMatchObject({ locale: 'fa' });
    expect((await freshStore()).locale).toBe('fa');
  });
});
