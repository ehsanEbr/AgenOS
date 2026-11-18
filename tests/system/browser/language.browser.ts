import type { Page } from '@playwright/test';
import { expect, pageHeading, test } from './fixtures';

/*
 * The interface language in a real browser (ADR-0012 D1; notes 24 to 27): English is the default whatever the browser prefers, Persian is
 * a choice the visitor makes, it brings the Persian text and the right-to-left layout, it survives a reload (the pre-paint script of
 * index.html applies it BEFORE the application starts) and it survives signing out. The jsdom tests compare the script with the store;
 * only a browser shows what a page does while its scripts are still loading, and where the layout really puts things.
 */

const PREFERENCES_KEY = 'agentos.ui-preferences';
const root = (page: Page) => page.locator('html');

/** Chooses a language with the select in the header (its label is in the current language). */
async function chooseLanguage(page: Page, selectLabel: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: selectLabel }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const savedLocale = async (page: Page): Promise<string | undefined> =>
  JSON.parse((await page.evaluate<string | null>(`localStorage.getItem('${PREFERENCES_KEY}')`)) ?? '{}').state
    ?.locale;

test.describe('a browser that prefers Persian', () => {
  test.use({ locale: 'fa-IR' });

  test('starts in English, left to right; Persian is a choice, and the choice survives a reload and being reversed', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    // The premise: this browser really does prefer Persian.
    expect(await page.evaluate<string>('navigator.language')).toBe('fa-IR');
    expect(await page.evaluate<string>('navigator.languages.join()')).toContain('fa');

    // Yet the application is English and left to right.
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(root(page)).toHaveAttribute('lang', 'en');
    expect(await root(page).getAttribute('dir')).not.toBe('rtl');
    const brandInEnglish = await page.getByRole('link', { name: 'AgentOS' }).boundingBox();
    expect(brandInEnglish!.x, 'the brand sits at the start (left) edge').toBeLessThan(200);

    // Choosing Persian gives the Persian text and the right-to-left layout.
    await chooseLanguage(page, 'Language', 'فارسی');
    await expect(pageHeading(page, 'ورود')).toBeVisible();
    await expect(root(page)).toHaveAttribute('lang', 'fa');
    await expect(root(page)).toHaveAttribute('dir', 'rtl');
    await expect(page.getByLabel('ایمیل', { exact: true })).toBeVisible();
    const viewport = page.viewportSize()!;
    const brandInPersian = await page.getByRole('link', { name: 'AgentOS' }).boundingBox();
    expect(
      brandInPersian!.x + brandInPersian!.width,
      'the brand moved to the start (right) edge',
    ).toBeGreaterThan(viewport.width - 200);
    expect(await savedLocale(page)).toBe('fa');

    // A reload keeps it.
    await page.reload();
    await expect(pageHeading(page, 'ورود')).toBeVisible();
    await expect(root(page)).toHaveAttribute('dir', 'rtl');

    // And so does the opposite choice: an explicit English beats the Persian browser after a reload, too.
    await chooseLanguage(page, 'زبان', 'English');
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(root(page)).toHaveAttribute('lang', 'en');
    expect(await root(page).getAttribute('dir')).not.toBe('rtl');
    expect(await savedLocale(page)).toBe('en');
    await page.reload();
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(root(page)).toHaveAttribute('lang', 'en');
  });
});

test.describe('the language before the application starts', () => {
  test('a saved Persian choice is on the page before any script of the application has run', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await chooseLanguage(page, 'Language', 'فارسی');
    await expect(root(page)).toHaveAttribute('dir', 'rtl');

    // Reload with the application's own scripts held back: only the inline script of index.html can have set anything.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route('**/assets/**', async (route) => {
      if (route.request().resourceType() !== 'script') return route.fallback();
      held += 1;
      await gate;
      return route.continue();
    });
    try {
      await page.reload({ waitUntil: 'commit' });
      await expect.poll(() => held, { message: 'the application script is being held' }).toBeGreaterThan(0);
      await expect(root(page)).toHaveAttribute('lang', 'fa');
      await expect(root(page)).toHaveAttribute('dir', 'rtl');
      expect(await page.locator('#root > *').count(), 'nothing of the application is drawn yet').toBe(0);
    } finally {
      release();
    }
    await expect(pageHeading(page, 'ورود')).toBeVisible();
    await expect(root(page)).toHaveAttribute('dir', 'rtl');
    await page.unroute('**/assets/**');
  });
});

test.describe('a Persian browser with nothing saved, before the application starts', () => {
  // The standard fixtures: `page` belongs to the test's own context, which is fresh (no saved preference) and is held to the automatic
  // rules of `fixtures.ts` (same-origin requests only, no uncaught page errors). Only the browser's language is set here.
  test.use({ locale: 'fa-IR' });

  test('the page is English, left to right, before any script of the application has run', async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route('**/assets/**', async (route) => {
      if (route.request().resourceType() !== 'script') return route.fallback();
      held += 1;
      await gate;
      return route.continue();
    });
    try {
      await page.goto('/sign-in', { waitUntil: 'commit' });
      await expect.poll(() => held, { message: 'the application script is being held' }).toBeGreaterThan(0);
      // The premise: this browser really does prefer Persian.
      expect(await page.evaluate<string>('navigator.language')).toBe('fa-IR');
      await expect(root(page)).toHaveAttribute('lang', 'en');
      expect(await root(page).getAttribute('dir')).not.toBe('rtl');
      expect(await page.locator('#root > *').count(), 'nothing of the application is drawn yet').toBe(0);
    } finally {
      release();
    }
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(root(page)).toHaveAttribute('lang', 'en');
    await page.unroute('**/assets/**');
  });
});

test.describe('the language and the session', () => {
  test('signing in and out in Persian keeps Persian, right to left, and the choice', async ({
    page,
    stack,
  }) => {
    const { ada } = stack.people;
    await page.goto('/sign-in');
    await chooseLanguage(page, 'Language', 'فارسی');
    await expect(pageHeading(page, 'ورود')).toBeVisible();

    await page.getByLabel('ایمیل', { exact: true }).fill(ada.email);
    await page.getByLabel('گذرواژه', { exact: true }).fill(ada.password);
    await page.getByRole('button', { name: 'ورود', exact: true }).click();
    await expect(page.getByRole('button', { name: 'منوی حساب' })).toBeVisible(); // the signed-in shell, in Persian
    await expect(root(page)).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeVisible();

    await page.getByRole('button', { name: 'منوی حساب' }).click();
    await page.getByRole('menuitem', { name: 'خروج' }).click();
    await expect(pageHeading(page, 'ورود')).toBeVisible(); // signed out: the sign-in page, still Persian
    await expect(root(page)).toHaveAttribute('lang', 'fa');
    await expect(root(page)).toHaveAttribute('dir', 'rtl');
    expect(await savedLocale(page)).toBe('fa');
  });
});
