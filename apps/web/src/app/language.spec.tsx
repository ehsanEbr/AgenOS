import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  healthOk,
  jsonResponse,
  mockFetch,
  notFoundError,
  organizationPage,
  testOrganization,
} from '../test/fixtures/api';
import { browserPrefers } from '../test/browser-language';
import { SIGNED_OUT, renderApp } from '../test/render';
import { UI_PREFERENCES_STORAGE_KEY, useUiPreferences } from './state/ui-preferences.store';

/*
 * The interface language through the real application: English is the default whatever the browser prefers, the visitor chooses
 * Persian or English with the language select (on the public pages as well as in the shell), and the choice is a preference of THIS
 * browser, independent of the session: signing out does not reset it. `fetch` is the only thing faked.
 */

const root = document.documentElement;
const directionOf = () => root.getAttribute('dir') ?? 'ltr';
const savedLocale = () =>
  (
    JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? '{}') as {
      state?: { locale?: string };
    }
  ).state?.locale;

function api() {
  return mockFetch(({ url }) => {
    const path = url.pathname;
    if (path.endsWith('/health')) return jsonResponse(healthOk);
    if (path.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    if (path.endsWith('/organizations')) return jsonResponse(organizationPage([testOrganization]));
    return jsonResponse(notFoundError, 404);
  });
}

/*
 * What this first group checks is how the sign-in page PRESENTS itself (English, left to right) under a browser language preference. It
 * does not test how the language is initialized: the test setup has already put the preferences store in English, and the store is
 * created once per test file. Initialization (nothing saved -> English, a saved choice wins) is tested where the store is created
 * afresh: `state/ui-preferences.store.spec.ts` and `providers/index-html.spec.ts`.
 */
describe('the sign-in page under a browser language preference', () => {
  it.each([
    ['a Persian browser', ['fa-IR', 'en-US']],
    ['a German browser', ['de-DE']],
  ])('is presented in English and left to right with %s', async (_, languages) => {
    browserPrefers(languages);
    api();
    renderApp('/sign-in', { session: SIGNED_OUT });

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(root.lang).toBe('en');
    expect(directionOf()).toBe('ltr');
  });
});

describe('choosing the language on the public pages', () => {
  it('lets the visitor switch to Persian and back: text, direction and the saved choice change, the page does not remount', async () => {
    api();
    renderApp('/sign-in', { session: SIGNED_OUT });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Language' }));
    fireEvent.click(await screen.findByTitle('فارسی'));
    expect(await screen.findByRole('heading', { level: 1, name: 'ورود' })).toBe(heading);
    expect(root.lang).toBe('fa');
    expect(directionOf()).toBe('rtl');
    expect(screen.getByLabelText('ایمیل')).toBeInTheDocument();
    expect(savedLocale()).toBe('fa');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'زبان' }));
    fireEvent.click(await screen.findByTitle('English'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBe(heading);
    expect(root.lang).toBe('en');
    expect(directionOf()).toBe('ltr');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(savedLocale()).toBe('en');
  }, 60_000);
});

describe('the language and the session', () => {
  it('signing out keeps the chosen language: the sign-in page is Persian and right to left, and the choice is still saved', async () => {
    api();
    renderApp('/', { preferences: { locale: 'fa' } });

    fireEvent.click(await screen.findByRole('button', { name: 'منوی حساب' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /خروج/ }));

    expect(await screen.findByRole('heading', { level: 1, name: 'ورود' })).toBeInTheDocument();
    expect(directionOf()).toBe('rtl');
    expect(useUiPreferences.getState().locale).toBe('fa');
    expect(savedLocale()).toBe('fa');
  }, 60_000);
});
