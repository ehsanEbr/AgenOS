/**
 * The registry of supported interface languages. The text direction, the `lang` attribute and the font stack all
 * derive from the active locale, so switching language switches direction too: there is one layout, not an LTR
 * layout plus a mirrored copy.
 *
 * To add a language: add an entry here, an Ant Design locale in `antd-locales.ts`, and a dictionary for every
 * namespace (the compiler lists what is missing).
 */
export type Direction = 'ltr' | 'rtl';

export interface LocaleDefinition {
  /** BCP 47 tag for the `lang` attribute and `Intl` formatting. */
  htmlLang: string;
  dir: Direction;
  /** Name of the language written in that language, for the language picker. */
  nativeName: string;
  /**
   * CSS font stack. System fonts first so nothing has to be downloaded; to ship a webfont, add an `@font-face`
   * (or a @fontsource import) and put its family name at the front of the relevant stack.
   */
  fontFamily: string;
}

const LATIN_FONTS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";

export const LOCALES = {
  en: { htmlLang: 'en', dir: 'ltr', nativeName: 'English', fontFamily: LATIN_FONTS },
  fa: {
    htmlLang: 'fa',
    dir: 'rtl',
    nativeName: 'فارسی',
    // Vazirmatn is used when installed; Tahoma and Segoe UI cover Arabic-script text on Windows, Noto elsewhere.
    fontFamily: `Vazirmatn, 'Segoe UI', Tahoma, 'Noto Sans Arabic', ${LATIN_FONTS}`,
  },
} as const satisfies Record<string, LocaleDefinition>;

export type LocaleCode = keyof typeof LOCALES;
export const LOCALE_CODES = Object.keys(LOCALES) as LocaleCode[];
/**
 * The language of a visitor who has not chosen one. It is English whatever the browser's language list says: the browser's preferences
 * are deliberately NOT consulted, so only an explicit choice (saved in the UI preferences) selects another language.
 */
export const DEFAULT_LOCALE: LocaleCode = 'en';

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && Object.hasOwn(LOCALES, value);
}
