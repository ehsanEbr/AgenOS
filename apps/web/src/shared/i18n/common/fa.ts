import type { MessagesOf } from '../types';
import type { commonEn } from './en';

export const commonFa: MessagesOf<typeof commonEn> = {
  actions: {
    retry: 'تلاش دوباره',
    goHome: 'بازگشت به نمای کلی',
  },
  states: {
    loading: 'در حال بارگذاری',
  },
  errors: {
    title: 'مشکلی پیش آمد',
    reference: 'شناسه پیگیری: {{id}}',
    network: 'ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید و دوباره تلاش کنید.',
    timeout: 'پاسخ سرور بیش از حد طول کشید. دوباره تلاش کنید.',
    invalid_response: 'سرور پاسخی فرستاد که برنامه قادر به درک آن نیست.',
    validation: 'برخی از اطلاعات معتبر نیستند.',
    unauthenticated: 'برای ادامه باید وارد شوید.',
    forbidden: 'شما اجازهٔ انجام این کار را ندارید.',
    not_found: 'مورد درخواستی پیدا نشد.',
    conflict: 'این کار با وضعیت فعلی تداخل دارد. صفحه را تازه کنید و دوباره تلاش کنید.',
    rate_limited: 'درخواست‌ها بیش از حد است. کمی صبر کنید و دوباره تلاش کنید.',
    unavailable: 'سرویس موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.',
    server: 'سرور با یک مشکل غیرمنتظره روبه‌رو شد.',
    unknown: 'خطای غیرمنتظره‌ای رخ داد.',
  },
  notFound: {
    title: 'صفحه پیدا نشد',
    description: 'صفحه‌ای که دنبال آن هستید وجود ندارد یا جابه‌جا شده است.',
  },
  boundary: {
    description: 'صفحه با یک خطای غیرمنتظره روبه‌رو شد.',
  },
};
