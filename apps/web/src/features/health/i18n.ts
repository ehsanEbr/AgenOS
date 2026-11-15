import type { Messages } from '../../shared/i18n/types';

const en = {
  label: 'API',
  status: {
    checking: 'API: checking',
    ok: 'API: online',
    unreachable: 'API: unreachable',
  },
};

export const healthMessages: Messages<typeof en> = {
  en,
  fa: {
    label: 'API',
    status: {
      checking: 'API: در حال بررسی',
      ok: 'API: آنلاین',
      unreachable: 'API: در دسترس نیست',
    },
  },
};
