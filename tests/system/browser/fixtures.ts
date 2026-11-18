import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import { Api } from './support/api';
import { readStackInfo, type Person, type StackInfo } from './support/stack-info';

export { expect };

interface Fixtures {
  stack: StackInfo;
  api: Api;
  /** Automatic: the rules every browser test is held to (see below). */
  houseRules: void;
}

/**
 * Every test starts from a fresh browser context (Playwright's default), so no cookie or storage crosses tests, and is held to two rules
 * that the suite can only get from a real browser:
 *   - HERMETIC: the page may talk to the stack's own origin and nothing else. A request to any other host is blocked and fails the test
 *     (the suite must never depend on the internet, and an accidental third-party asset is a finding);
 *   - NO SCRIPT ERRORS: an uncaught error in any page of the context fails the test.
 * `baseURL` is the throwaway stack's web origin, so a test writes paths.
 */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures a function needs from its destructured first argument
  stack: async ({}, use) => {
    await use(readStackInfo());
  },
  api: async ({ stack }, use) => {
    await use(new Api(stack.webOrigin));
  },
  baseURL: async ({ stack }, use) => {
    await use(stack.webOrigin);
  },
  houseRules: [
    async ({ context, stack }, use) => {
      const foreign: string[] = [];
      const errors: string[] = [];
      // The stack's own origin, and the same port on the numeric loopback address (the same server; one test opens it that way on purpose).
      const own = new Set([stack.webOrigin, `http://127.0.0.1:${new URL(stack.webOrigin).port}`]);
      await context.route(
        (url) => /^https?:$/.test(url.protocol) && !own.has(url.origin),
        async (route) => {
          foreign.push(route.request().url());
          await route.abort('blockedbyclient');
        },
      );
      context.on('weberror', (error) => errors.push(error.error().message));
      await use();
      expect(foreign, 'requests to a host other than the stack origin').toEqual([]);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});

/** The name of the API's session cookie over plain HTTP (it carries the `__Host-` prefix only over HTTPS). */
const SESSION_COOKIE = 'agentos_session';

export async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((entry) => entry.name === SESSION_COOKIE);
  if (!cookie) throw new Error('there is no session cookie in this browser context');
  expect(cookie.httpOnly, 'the session cookie must be HttpOnly').toBe(true);
  return cookie.value;
}

/** Signs in through the sign-in form, as a person would. */
export async function signInThroughTheUi(page: Page, person: Person): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

/**
 * Gives the context a real session without driving the form (for tests where signing in is not the behavior under test). The login goes
 * through the browser context's own request client, so the HttpOnly cookie lands in the context exactly as the form's sign-in would
 * set it, and the request carries the `Origin` the API requires.
 */
export async function signInThroughTheApi(
  context: BrowserContext,
  stack: StackInfo,
  person: Person,
): Promise<void> {
  const response = await context.request.post(`${stack.webOrigin}/api/v1/auth/login`, {
    headers: { origin: stack.webOrigin },
    data: { email: person.email, password: person.password },
  });
  expect(response.status(), `signing ${person.email} in`).toBe(200);
}

export const projectsPath = (organizationId: string) => `/organizations/${organizationId}/projects`;
export const projectPath = (organizationId: string, projectId: string) =>
  `${projectsPath(organizationId)}/${projectId}`;
export const membersPath = (organizationId: string, projectId: string) =>
  `${projectPath(organizationId, projectId)}/members`;

/** The page's single level-one heading (every page has exactly one). */
export const pageHeading = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { level: 1, name });
