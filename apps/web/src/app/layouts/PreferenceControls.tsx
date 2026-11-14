import { Flex, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import { LOCALES, LOCALE_CODES, type LocaleCode } from '../../shared/i18n/locales';
import { THEME_MODES, type ThemeMode } from '../../shared/theme/theme';
import { useUiPreferences } from '../state/ui-preferences.store';

/** Theme and language pickers. Changing either re-themes / mirrors the whole app: there is no per-page handling. */
export function PreferenceControls() {
  const { t } = useTranslation('shell');
  const themeMode = useUiPreferences((s) => s.themeMode);
  const locale = useUiPreferences((s) => s.locale);
  const setThemeMode = useUiPreferences((s) => s.setThemeMode);
  const setLocale = useUiPreferences((s) => s.setLocale);

  return (
    <Flex gap="small" align="center">
      <Select<ThemeMode>
        aria-label={t('preferences.theme.label')}
        value={themeMode}
        onChange={setThemeMode}
        popupMatchSelectWidth={false}
        options={THEME_MODES.map((mode) => ({ value: mode, label: t(`preferences.theme.${mode}`) }))}
        style={{ minInlineSize: 112 }}
      />
      <Select<LocaleCode>
        aria-label={t('preferences.language.label')}
        value={locale}
        onChange={setLocale}
        popupMatchSelectWidth={false}
        options={LOCALE_CODES.map((code) => ({
          value: code,
          // Each language is named in itself and carries its own `lang`, so screen readers pronounce it correctly.
          label: <span lang={LOCALES[code].htmlLang}>{LOCALES[code].nativeName}</span>,
          title: LOCALES[code].nativeName,
        }))}
        style={{ minInlineSize: 112 }}
      />
    </Flex>
  );
}
