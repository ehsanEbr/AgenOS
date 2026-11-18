import { defineConfig, devices } from '@playwright/test';

/*
 * Real-browser end-to-end tests (ADR-0012 D1). They are a separate runner entry next to the Vitest system tests: their own config, their
 * own file suffix (`*.browser.ts`, which the Vitest `include` of `test/**\/*.system.spec.ts` never matches) and their own script
 * (`pnpm test:browser`). Chromium only. Linux CI runs them in the `browser` job; a developer may run them locally after
 * `pnpm browser:install`.
 *
 * Isolation: `browser/global-setup.ts` boots ONE throwaway Compose stack (own project name, volumes, network, ports and generated
 * credentials, see `src/stack.ts`) and destroys it afterwards. Every test gets a fresh browser context (no cookie or storage crosses
 * tests) and builds its own organization, so the tests do not depend on each other or on their order. One worker and no retries: a
 * retry would hide the flake it should expose.
 */
export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.ts',
  globalSetup: './browser/global-setup.ts',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  outputDir: 'test-results',

  use: {
    // `baseURL` is the throwaway stack's web origin; the `browser/fixtures.ts` fixture sets it once the stack exists.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      // English, UTC and a desktop viewport are the defaults; a test that needs another language says so.
      use: { ...devices['Desktop Chrome'], locale: 'en-US', timezoneId: 'UTC' },
    },
  ],
});
