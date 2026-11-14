import { healthMessages } from '../../features/health';
import { homeMessages } from '../../features/home';
import { commonEn } from '../../shared/i18n/common/en';
import { commonFa } from '../../shared/i18n/common/fa';
import type { LocaleCode } from '../../shared/i18n/locales';
import { shellMessages } from './shell';

/**
 * Every namespace, per locale. The shell composes the application's messages here: `common` belongs to shared UI,
 * `shell` to the app layer, and each feature owns its own namespace and exports it from its public `index.ts`.
 * A new feature adds one line per locale here.
 */
export const resources = {
  en: { common: commonEn, shell: shellMessages.en, home: homeMessages.en, health: healthMessages.en },
  fa: { common: commonFa, shell: shellMessages.fa, home: homeMessages.fa, health: healthMessages.fa },
} as const satisfies Record<LocaleCode, object>;

export type AppResources = typeof resources.en;
