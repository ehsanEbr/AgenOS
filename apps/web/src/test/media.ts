import { act } from '@testing-library/react';

/**
 * A controllable `window.matchMedia` for jsdom (which has none). Understands exactly the queries the app uses:
 * `(min-width: Npx)`, `(max-width: Npx)`, `(prefers-color-scheme: dark|light)` and `(prefers-reduced-motion: reduce)`.
 * Tests change the "device" with the setters below; subscribers (useMediaQuery, Ant Design's responsive observer) are notified.
 */
interface Environment {
  width: number;
  prefersDark: boolean;
  reducedMotion: boolean;
}

const DEFAULTS: Environment = { width: 1280, prefersDark: false, reducedMotion: false };
const environment: Environment = { ...DEFAULTS };
const listeners = new Set<() => void>();

function evaluate(query: string): boolean {
  const min = /\(min-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  if (min) return environment.width >= Number(min[1]);
  const max = /\(max-width:\s*(\d+(?:\.\d+)?)px\)/.exec(query);
  if (max) return environment.width <= Number(max[1]);
  if (query.includes('prefers-color-scheme: dark')) return environment.prefersDark;
  if (query.includes('prefers-color-scheme: light')) return !environment.prefersDark;
  if (query.includes('prefers-reduced-motion: reduce')) return environment.reducedMotion;
  return false;
}

export function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return evaluate(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    }),
  });
}

function update(change: Partial<Environment>): void {
  Object.assign(environment, change);
  act(() => listeners.forEach((listener) => listener()));
}

/** Resize the "viewport". 1280 is a desktop, 500 a phone. Ant Design's `lg` breakpoint is 992. */
export const setViewportWidth = (width: number) => update({ width });
export const setSystemDarkMode = (prefersDark: boolean) => update({ prefersDark });
export const setReducedMotion = (reducedMotion: boolean) => update({ reducedMotion });

export function resetMedia(): void {
  Object.assign(environment, DEFAULTS);
  listeners.clear();
}
