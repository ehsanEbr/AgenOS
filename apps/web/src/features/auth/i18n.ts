import type { Messages } from '../../shared/i18n/types';

/** Namespace `auth`: sign-in, sign-up, the user menu and the session states. Persian needs a native-speaker review before release. */
const en = {
  signIn: {
    title: 'Sign in',
    description: 'Use your AgentOS account.',
    email: 'Email',
    password: 'Password',
    submit: 'Sign in',
    noAccount: 'Need an account?',
    toSignUp: 'Create one',
    registered: 'Your account was created. Sign in to continue.',
    ended: 'Your session ended. Sign in again.',
  },
  signUp: {
    title: 'Create an account',
    description: 'Create your AgentOS account.',
    email: 'Email',
    displayName: 'Name',
    password: 'Password',
    passwordHint: 'Use at least {{min}} characters.',
    submit: 'Create account',
    haveAccount: 'Already have an account?',
    toSignIn: 'Sign in',
    closed: {
      title: 'Registration is closed',
      description:
        'New accounts can only be added by an administrator. Ask for an account, or sign in if you already have one.',
    },
  },
  fields: {
    emailRequired: 'Enter your email address.',
    emailInvalid: 'Enter a valid email address.',
    passwordRequired: 'Enter your password.',
    passwordTooShort: 'Use at least {{min}} characters.',
    passwordTooLong: 'This password is too long.',
    nameRequired: 'Enter your name.',
    nameTooLong: 'Use at most {{max}} characters.',
    invalid: 'This value is not valid.',
    emailTaken: 'An account with this email already exists.',
  },
  errors: {
    invalidCredentials: 'Incorrect email or password.',
    tooManyAttempts: 'Too many attempts. Wait a few minutes and try again.',
    unavailable: 'Sign-in is temporarily unavailable. Try again shortly.',
    inProgress: 'A request is already in progress. Wait for it to finish, then try again.',
    originNotAllowed:
      'This web address is not allowed to sign in. Open the app from the address your administrator configured and try again.',
  },
  session: {
    checking: 'Checking your session',
    failedTitle: 'Could not check your session',
    incompleteTitle: 'Sign-out is not complete',
    incompleteDescription:
      'We could not confirm that you were signed out, so your information is hidden. Try signing out again.',
    retrySignOut: 'Retry sign-out',
    toSignIn: 'Go to sign in',
  },
  userMenu: {
    label: 'Account menu',
    signedInAs: 'Signed in as {{email}}',
    signOut: 'Sign out',
  },
};

export const authMessages: Messages<typeof en> = {
  en,
  fa: {
    signIn: {
      title: 'ورود',
      description: 'با حساب AgentOS خود وارد شوید.',
      email: 'ایمیل',
      password: 'گذرواژه',
      submit: 'ورود',
      noAccount: 'حساب ندارید؟',
      toSignUp: 'ایجاد حساب',
      registered: 'حساب شما ایجاد شد. برای ادامه وارد شوید.',
      ended: 'نشست شما به پایان رسید. دوباره وارد شوید.',
    },
    signUp: {
      title: 'ایجاد حساب',
      description: 'حساب AgentOS خود را ایجاد کنید.',
      email: 'ایمیل',
      displayName: 'نام',
      password: 'گذرواژه',
      passwordHint: 'دست‌کم {{min}} نویسه استفاده کنید.',
      submit: 'ایجاد حساب',
      haveAccount: 'از قبل حساب دارید؟',
      toSignIn: 'ورود',
      closed: {
        title: 'ثبت‌نام بسته است',
        description:
          'حساب جدید را فقط مدیر می‌تواند اضافه کند. از مدیر حساب بخواهید، یا اگر حساب دارید وارد شوید.',
      },
    },
    fields: {
      emailRequired: 'نشانی ایمیل خود را وارد کنید.',
      emailInvalid: 'یک نشانی ایمیل معتبر وارد کنید.',
      passwordRequired: 'گذرواژه خود را وارد کنید.',
      passwordTooShort: 'دست‌کم {{min}} نویسه استفاده کنید.',
      passwordTooLong: 'این گذرواژه بیش از حد طولانی است.',
      nameRequired: 'نام خود را وارد کنید.',
      nameTooLong: 'حداکثر {{max}} نویسه استفاده کنید.',
      invalid: 'این مقدار معتبر نیست.',
      emailTaken: 'حسابی با این ایمیل از قبل وجود دارد.',
    },
    errors: {
      invalidCredentials: 'ایمیل یا گذرواژه نادرست است.',
      tooManyAttempts: 'تلاش‌های بیش از حد. چند دقیقه صبر کنید و دوباره تلاش کنید.',
      unavailable: 'ورود موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.',
      inProgress: 'درخواستی از قبل در حال انجام است. صبر کنید تا تمام شود و دوباره تلاش کنید.',
      originNotAllowed:
        'ورود از این نشانی وب مجاز نیست. برنامه را از نشانی‌ای که مدیر تنظیم کرده باز کنید و دوباره تلاش کنید.',
    },
    session: {
      checking: 'در حال بررسی نشست شما',
      failedTitle: 'بررسی نشست شما انجام نشد',
      incompleteTitle: 'خروج کامل نشده است',
      incompleteDescription:
        'نتوانستیم تأیید کنیم که از حساب خارج شده‌اید، پس اطلاعات شما پنهان شده است. دوباره خروج را امتحان کنید.',
      retrySignOut: 'تلاش دوباره برای خروج',
      toSignIn: 'رفتن به صفحهٔ ورود',
    },
    userMenu: {
      label: 'منوی حساب',
      signedInAs: 'واردشده با {{email}}',
      signOut: 'خروج',
    },
  },
};
