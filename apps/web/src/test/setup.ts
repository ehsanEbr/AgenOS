import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { defaultPreferences, useUiPreferences } from '../app/state/ui-preferences.store';
import { installMatchMedia, resetMedia } from './media';

// Testing Library's default wait for findBy*/waitFor is 1 s, which a loaded runner exceeds (the app-shell test flaked on it in CI), and
// the 4 s that replaced it was exceeded too by the heavy router specs on a hosted runner. 15 s stays below the default test timeout of
// 30 s (vite.config.ts), so a real failure is still reported by the assertion, not by the timeout.
configure({ asyncUtilTimeout: 15_000 });

// Ant Design relies on browser APIs jsdom does not implement.
class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// jsdom does not implement pseudo-element styles ("Not implemented: getComputedStyle(elt, pseudoElt)"); Ant Design asks for
// them when measuring scrollbars. Ignoring the second argument is what the jsdom docs recommend.
const originalGetComputedStyle = window.getComputedStyle.bind(window);

function installBrowserStubs() {
  window.getComputedStyle = (element) => originalGetComputedStyle(element);
  installMatchMedia();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}

beforeEach(() => {
  installBrowserStubs();
  document.title = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('dir');
  document.documentElement.lang = 'en';
  // Every test starts as a first-time visitor on an English, light-or-system desktop browser.
  window.localStorage.clear();
  useUiPreferences.setState({ ...defaultPreferences(), locale: 'en', themeMode: 'light' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetMedia();
});
