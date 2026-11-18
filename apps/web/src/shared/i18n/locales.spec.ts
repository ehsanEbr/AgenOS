import { describe, expect, it } from 'vitest';
import { ANTD_LOCALES } from './antd-locales';
import { DEFAULT_LOCALE, LOCALES, LOCALE_CODES, isLocaleCode } from './locales';

describe('locale registry', () => {
  it('declares a direction, language tag, name and font for every locale', () => {
    for (const code of LOCALE_CODES) {
      const locale = LOCALES[code];
      expect(['ltr', 'rtl']).toContain(locale.dir);
      expect(locale.htmlLang).toBe(code);
      expect(locale.nativeName.length).toBeGreaterThan(0);
      expect(locale.fontFamily.length).toBeGreaterThan(0);
    }
  });

  it('supports English (LTR) and Persian (RTL)', () => {
    expect(LOCALES.en.dir).toBe('ltr');
    expect(LOCALES.fa.dir).toBe('rtl');
  });

  it('has an Ant Design locale for every language', () => {
    for (const code of LOCALE_CODES) expect(ANTD_LOCALES[code]).toBeDefined();
    expect(ANTD_LOCALES.fa.locale).toBe('fa');
  });

  it('puts an Arabic-script capable font in the Persian stack', () => {
    expect(LOCALES.fa.fontFamily).toMatch(/Vazirmatn|Tahoma|Noto Sans Arabic/);
  });
});

describe('the default language', () => {
  it('is English (left to right): the language of anyone who has not chosen one', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(LOCALES[DEFAULT_LOCALE].dir).toBe('ltr');
  });
});

describe('isLocaleCode', () => {
  it('accepts only registered codes', () => {
    expect(isLocaleCode('fa')).toBe(true);
    expect(isLocaleCode('xx')).toBe(false);
    expect(isLocaleCode(undefined)).toBe(false);
    expect(isLocaleCode('toString')).toBe(false);
  });
});
