import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALE_CODES, type LocaleCode, detectLocale } from '../../shared/i18n/locales';
import { THEME_MODES, type ThemeMode } from '../../shared/theme/theme';

/**
 * User preferences that belong to THIS browser: theme, language, sidebar. This is genuine client state, so it lives in
 * Zustand and is persisted. Server data never goes here (that is TanStack Query's job), and short-lived UI state such
 * as "is this dialog open" stays in the component with `useState`.
 *
 * Read with a selector so a component re-renders only when the value it uses changes:
 *   const themeMode = useUiPreferences((s) => s.themeMode);
 */
export const UI_PREFERENCES_STORAGE_KEY = 'agentos.ui-preferences';

export interface UiPreferences {
  themeMode: ThemeMode;
  locale: LocaleCode;
  sidebarCollapsed: boolean;
}

interface UiPreferencesState extends UiPreferences {
  setThemeMode: (mode: ThemeMode) => void;
  setLocale: (locale: LocaleCode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export function defaultPreferences(): UiPreferences {
  const languages = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  return { themeMode: 'system', locale: detectLocale(languages), sidebarCollapsed: false };
}

// Stored data is untrusted (hand-edited, from an older version, corrupted): validate each field, fall back per field.
const storedSchema = z.object({
  themeMode: z.enum(THEME_MODES as [ThemeMode, ...ThemeMode[]]).catch('system'),
  locale: z.enum(LOCALE_CODES as [LocaleCode, ...LocaleCode[]]).catch(DEFAULT_LOCALE),
  sidebarCollapsed: z.boolean().catch(false),
});

/** localStorage can be missing or throw (private mode, blocked storage). Preferences then simply do not persist. */
const safeStorage = {
  getItem: (name: string) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      /* ignore: preferences just will not persist */
    }
  },
  removeItem: (name: string) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const useUiPreferences = create<UiPreferencesState>()(
  persist(
    (set) => ({
      ...defaultPreferences(),
      setThemeMode: (themeMode) => set({ themeMode }),
      setLocale: (locale) => set({ locale }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    }),
    {
      name: UI_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ themeMode, locale, sidebarCollapsed }): UiPreferences => ({
        themeMode,
        locale,
        sidebarCollapsed,
      }),
      // Nothing saved -> keep the current (default) state. Something saved -> it wins, field by field, and any
      // invalid field falls back to its default instead of being trusted.
      merge: (persisted, current) => ({
        ...current,
        ...storedSchema.parse({
          ...current,
          ...(typeof persisted === 'object' && persisted !== null ? persisted : {}),
        }),
      }),
    },
  ),
);
