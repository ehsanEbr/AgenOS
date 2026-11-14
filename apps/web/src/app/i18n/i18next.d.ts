import 'i18next';
import type { AppResources } from './resources';

// Makes `t('shell:nav.label')` and `useTranslation('health')` type-checked: a misspelled key is a compile error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: AppResources;
  }
}
