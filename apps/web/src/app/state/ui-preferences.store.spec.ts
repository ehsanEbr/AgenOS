import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      state: { themeMode: 'dark', locale: 'fa', sidebarCollapsed: true },
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

describe('defaultPreferences', () => {
  it('chooses Persian for a Persian browser and English otherwise', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fa-IR', 'en-US']);
    expect(defaultPreferences().locale).toBe('fa');

    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'en-US']);
    expect(defaultPreferences().locale).toBe('en');

    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'fr']);
    expect(defaultPreferences().locale).toBe('en'); // unsupported -> default
  });

  it('follows the system theme and starts with an expanded sidebar', () => {
    expect(defaultPreferences()).toMatchObject({ themeMode: 'system', sidebarCollapsed: false });
  });
});
