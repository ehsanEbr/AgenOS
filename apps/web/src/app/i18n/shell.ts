import type { Messages } from '../../shared/i18n/types';

/** Namespace `shell`: strings owned by the application shell (navigation, preferences, accessibility labels). */
const en = {
  brand: 'AgentOS',
  skipToContent: 'Skip to main content',
  documentTitle: '{{page}} · AgentOS',
  nav: {
    label: 'Main navigation',
    open: 'Open navigation',
    close: 'Close navigation',
    loadingPage: 'Loading page',
    planned: 'Soon',
    plannedHint: 'Not available yet',
    items: {
      overview: 'Overview',
      projects: 'Projects',
      agents: 'Agents',
      models: 'Models',
      mcpGateway: 'MCP Gateway',
      softwareIntelligence: 'Software Intelligence',
      executions: 'Executions',
      observability: 'Observability',
      settings: 'Settings',
    },
  },
  preferences: {
    theme: {
      label: 'Theme',
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },
    language: {
      label: 'Language',
    },
  },
};

export const shellMessages: Messages<typeof en> = {
  en,
  fa: {
    brand: 'AgentOS',
    skipToContent: 'رفتن به محتوای اصلی',
    documentTitle: '{{page}} · AgentOS',
    nav: {
      label: 'ناوبری اصلی',
      open: 'باز کردن ناوبری',
      close: 'بستن ناوبری',
      loadingPage: 'در حال بارگذاری صفحه',
      planned: 'به‌زودی',
      plannedHint: 'هنوز در دسترس نیست',
      items: {
        overview: 'نمای کلی',
        projects: 'پروژه‌ها',
        agents: 'عامل‌ها',
        models: 'مدل‌ها',
        mcpGateway: 'دروازهٔ MCP',
        softwareIntelligence: 'هوشمندی نرم‌افزار',
        executions: 'اجراها',
        observability: 'مشاهده‌پذیری',
        settings: 'تنظیمات',
      },
    },
    preferences: {
      theme: {
        label: 'پوسته',
        light: 'روشن',
        dark: 'تیره',
        system: 'مطابق سیستم',
      },
      language: {
        label: 'زبان',
      },
    },
  },
};
