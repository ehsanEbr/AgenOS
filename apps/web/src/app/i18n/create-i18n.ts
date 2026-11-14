import { createInstance, type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LOCALE_CODES, type LocaleCode } from '../../shared/i18n/locales';
import { resources } from './resources';

/**
 * Creates an isolated i18next instance (one per app, one per test), initialized synchronously: all dictionaries are
 * bundled, so the first render already has its strings. When dictionaries grow large, switch to lazy-loaded
 * namespaces (`i18next-resources-to-backend`) inside this function only.
 */
export function createI18n(locale: LocaleCode): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: LOCALE_CODES,
    ns: Object.keys(resources.en),
    defaultNS: 'common',
    resources,
    interpolation: { escapeValue: false }, // React already escapes
    initAsync: false, // resources are bundled: initialize synchronously
  });
  return instance;
}
