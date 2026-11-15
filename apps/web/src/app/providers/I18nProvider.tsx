import type { i18n as I18n } from 'i18next';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n/create-i18n';
import { useUiPreferences } from '../state/ui-preferences.store';

interface I18nProviderProps {
  children: ReactNode;
  /** Tests inject an instance; the app creates its own from the stored language. */
  i18n?: I18n;
}

/** Provides translations and keeps i18next on the language chosen in the UI preferences. */
export function I18nProvider({ children, i18n: injected }: I18nProviderProps) {
  const locale = useUiPreferences((s) => s.locale);
  const [i18n] = useState(() => injected ?? createI18n(locale));

  // Dictionaries are bundled, so this completes synchronously and runs before paint.
  useLayoutEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
