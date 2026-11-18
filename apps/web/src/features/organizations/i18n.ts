import type { Messages } from '../../shared/i18n/types';

/** Namespace `organizations`: the organization chooser, the first-organization flow and the switcher. Persian needs a native-speaker review before release. */
const en = {
  roles: {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
    viewer: 'Viewer',
  },
  chooser: {
    title: 'Choose an organization',
    description: 'Pick the organization you want to work in.',
    showing: 'Showing {{loaded}} of {{total}} organizations.',
    loadMore: 'Load more',
  },
  createFirst: {
    title: 'Create your first organization',
    description:
      'An organization holds your projects and the people who work on them. You will be its owner.',
    name: 'Organization name',
    submit: 'Create organization',
  },
  fields: {
    nameRequired: 'Enter a name for the organization.',
    nameTooLong: 'Use at most {{max}} characters.',
    invalid: 'This value is not valid.',
  },
  switcher: {
    current: 'Organization: {{name}}',
    choose: 'Select an organization',
    menuLabel: 'Switch organization',
    loading: 'Loading organizations',
    failed: 'Could not load organizations',
    retry: 'Try again',
    showing: 'Showing {{loaded}} of {{total}}',
    loadMore: 'Load more',
    empty: 'You are not a member of any organization yet.',
  },
  notFound: {
    title: 'Organization not found',
    description: 'It may not exist, or you may not have access to it.',
    toChooser: 'Choose an organization',
  },
};

export const organizationMessages: Messages<typeof en> = {
  en,
  fa: {
    roles: {
      owner: 'مالک',
      admin: 'مدیر',
      member: 'عضو',
      viewer: 'بیننده',
    },
    chooser: {
      title: 'یک سازمان را انتخاب کنید',
      description: 'سازمانی را که می‌خواهید در آن کار کنید انتخاب کنید.',
      showing: 'نمایش {{loaded}} از {{total}} سازمان.',
      loadMore: 'بارگیری بیشتر',
    },
    createFirst: {
      title: 'نخستین سازمان خود را بسازید',
      description:
        'سازمان، پروژه‌ها و افرادی را که روی آن‌ها کار می‌کنند در بر می‌گیرد. شما مالک آن خواهید بود.',
      name: 'نام سازمان',
      submit: 'ساخت سازمان',
    },
    fields: {
      nameRequired: 'نامی برای سازمان وارد کنید.',
      nameTooLong: 'حداکثر {{max}} نویسه استفاده کنید.',
      invalid: 'این مقدار معتبر نیست.',
    },
    switcher: {
      current: 'سازمان: {{name}}',
      choose: 'یک سازمان انتخاب کنید',
      menuLabel: 'تغییر سازمان',
      loading: 'در حال بارگیری سازمان‌ها',
      failed: 'بارگیری سازمان‌ها انجام نشد',
      retry: 'تلاش دوباره',
      showing: 'نمایش {{loaded}} از {{total}}',
      loadMore: 'بارگیری بیشتر',
      empty: 'هنوز عضو هیچ سازمانی نیستید.',
    },
    notFound: {
      title: 'سازمان پیدا نشد',
      description: 'ممکن است وجود نداشته باشد یا به آن دسترسی نداشته باشید.',
      toChooser: 'انتخاب سازمان',
    },
  },
};
