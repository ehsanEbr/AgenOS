import enUS from 'antd/locale/en_US';
import faIR from 'antd/locale/fa_IR';
import type { Locale } from 'antd/es/locale';
import type { LocaleCode } from './locales';

/** Ant Design's own strings (date pickers, pagination, empty states, ...). Typed so a new locale cannot be forgotten. */
export const ANTD_LOCALES: Record<LocaleCode, Locale> = {
  en: enUS,
  fa: faIR,
};
