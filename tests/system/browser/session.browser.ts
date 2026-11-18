import { expireSession } from './support/database';
import { newWorld, type Api } from './support/api';
import type { StackInfo } from './support/stack-info';
import {
  expect,
  membersPath,
  pageHeading,
  projectPath,
  sessionCookie,
  signInThroughTheApi,
  signInThroughTheUi,
  test,
} from './fixtures';

/*
 * The session across real navigation (ADR-0012 D4): a cookie that survives a reload, a deep link that survives signing in, a session that
 * ends on the server, sign-out, and a second tab that has not heard of it. The state machine is covered by the jsdom tests; this is the
 * part that needs a real cookie, a real history and real tabs.
 */

const ENDED = 'Your session ended. Sign in again.';
const PREFERENCES_KEY = 'agentos.ui-preferences';

test.describe('the session', () => {
  async function projectOf({ stack, api }: { stack: StackInfo; api: Api }) {
    const { ada } = stack.people;
    const world = await newWorld(api, ada);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Session ${world.tag}`,
      `session-${world.tag}`,
    );
    return { ...world, project, ada };
  }

  test('a deep link opened without a session goes to sign-in and, after signing in, to the deep link; a reload keeps the session', async ({
    page,
    stack,
    api,
  }) => {
    const { organizationId, project, ada } = await projectOf({ stack, api });
    const target = membersPath(organizationId, project.id);

    await page.goto(target);
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByText(ENDED)).toHaveCount(0); // arriving without a session is not "the session ended"

    await page.getByLabel('Email', { exact: true }).fill(ada.email);
    await page.getByLabel('Password', { exact: true }).fill(ada.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(pageHeading(page, project.name)).toBeVisible();

    // A real reload: the HttpOnly cookie signs the person in again before anything private is drawn.
    await page.reload();
    await expect(pageHeading(page, project.name)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
  });

  test('a session that ends on the server returns the person to sign-in at their next request, clears the stored organization, and signing in returns them to the page', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { organizationId, project, ada } = await projectOf({ stack, api });
    const target = membersPath(organizationId, project.id);
    await signInThroughTheUi(page, ada);
    await page.goto(target);
    await expect(pageHeading(page, project.name)).toBeVisible();
    const stored = await page.evaluate<string | null>(`localStorage.getItem('${PREFERENCES_KEY}')`);
    expect(JSON.parse(stored ?? '{}').state.lastOrganizationId, 'the organization in use is remembered').toBe(
      organizationId,
    );

    // The server forgets the session (its idle limit passes). The page does not know yet.
    await expireSession(stack, await sessionCookie(context));
    await expect(pageHeading(page, project.name)).toBeVisible();

    // The next private request answers 401: the app ends the session, removes the private UI and sends the person to sign in.
    await page.getByRole('main').getByRole('button', { name: 'Add member' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByText(ENDED)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    await expect(page.getByText(project.name)).toHaveCount(0);
    const after = await page.evaluate<string | null>(`localStorage.getItem('${PREFERENCES_KEY}')`);
    expect(
      JSON.parse(after ?? '{}').state.lastOrganizationId,
      'the stored organization is forgotten with the session',
    ).toBeNull();

    // Signing in again returns to where they were.
    await page.getByLabel('Email', { exact: true }).fill(ada.email);
    await page.getByLabel('Password', { exact: true }).fill(ada.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${target}$`));
    await expect(pageHeading(page, project.name)).toBeVisible();
  });

  test('signing out ends the session: the cookie goes, Back does not show the private page, the stored organization is forgotten', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { organizationId, project, ada } = await projectOf({ stack, api });
    await signInThroughTheApi(context, stack, ada);
    await page.goto(projectPath(organizationId, project.id));
    await expect(pageHeading(page, project.name)).toBeVisible();
    await page.getByRole('link', { name: 'Members', exact: true }).click(); // a second entry in the history, inside the private area
    await expect(page).toHaveURL(new RegExp(`${membersPath(organizationId, project.id)}$`));

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByText(ENDED)).toHaveCount(0); // a deliberate sign-out is not "the session ended"
    expect(
      (await context.cookies()).some((cookie) => cookie.name === 'agentos_session' && cookie.value !== ''),
    ).toBe(false);
    const stored = await page.evaluate<string | null>(`localStorage.getItem('${PREFERENCES_KEY}')`);
    expect(JSON.parse(stored ?? '{}').state.lastOrganizationId).toBeNull();

    await page.goBack(); // the history still holds the project page (the guard replaced only the members entry); it is not drawn
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByText(project.name)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
  });

  test('a second tab that has not heard of a sign-out finds out at its next request (the documented several-tabs limit)', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { organizationId, project, ada } = await projectOf({ stack, api });
    await signInThroughTheApi(context, stack, ada);
    await page.goto(projectPath(organizationId, project.id));
    await expect(pageHeading(page, project.name)).toBeVisible();

    const other = await context.newPage();
    await other.goto(membersPath(organizationId, project.id));
    await expect(pageHeading(other, project.name)).toBeVisible();

    // Tab 1 signs out.
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    // Tab 2 still shows what it had loaded (ADR-0012 does not claim an immediate cross-tab sign-out) ...
    await expect(pageHeading(other, project.name)).toBeVisible();
    // ... and on its next private request it learns that the session is gone.
    await other.getByRole('main').getByRole('button', { name: 'Add member' }).click();
    await expect(other).toHaveURL(/\/sign-in$/);
    await expect(other.getByText(ENDED)).toBeVisible();
    await expect(other.getByText(project.name)).toHaveCount(0);
  });
});
