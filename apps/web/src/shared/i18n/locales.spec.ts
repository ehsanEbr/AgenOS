import { describe, expect, it } from 'vitest';
import { ANTD_LOCALES } from './antd-locales';
import { DEFAULT_LOCALE, LOCALES, LOCALE_CODES, detectLocale, isLocaleCode } from './locales';

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

describe('detectLocale', () => {
  it('matches on the primary language subtag, case-insensitively', () => {
    expect(detectLocale(['fa-IR'])).toBe('fa');
    expect(detectLocale(['FA'])).toBe('fa');
    expect(detectLocale(['en-GB'])).toBe('en');
  });

  it('takes the first supported language from the preference list', () => {
    expect(detectLocale(['de', 'fa', 'en'])).toBe('fa');
  });

  it('falls back to the default', () => {
    expect(detectLocale([])).toBe(DEFAULT_LOCALE);
    expect(detectLocale(['ja', 'zh-CN'])).toBe(DEFAULT_LOCALE);
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
