import { newWorld, PASSWORD, unique } from './support/api';
import { expect, pageHeading, projectPath, test } from './fixtures';

/*
 * A new person's first visit, through the real application (ADR-0012 D1): register, sign in, create the first organization and the first
 * project, and meet the same "not found" for another organization's project. Everything below the sign-up form is the behavior under
 * test and goes through the UI; the other organization's data is set up through the API.
 */

test.describe('a new person', () => {
  test('registers, signs in, creates an organization and a project, and cannot reach another organization', async ({
    page,
    context,
    stack,
    api,
  }) => {
    // Somebody else's organization and project, which the new person must never see.
    const world = await newWorld(api, stack.people.ada);
    const secret = await api.createProject(
      stack.people.ada,
      world.organizationId,
      'Secret Plans',
      `secret-${world.tag}`,
    );

    // 1. An anonymous visitor to the private app is sent to sign in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);

    // 2. Registration through the form. The account is created; it is not signed in until the person signs in.
    const email = `zoe.${unique()}@example.com`;
    await page.getByRole('link', { name: 'Create one' }).click();
    await expect(pageHeading(page, 'Create an account')).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Name', { exact: true }).fill('Zoe Newcomer');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    await expect(page.getByText('Your account was created. Sign in to continue.')).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);

    // 3. Signing in sets an HttpOnly session cookie: script in the page cannot read it, the browser still sends it.
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(pageHeading(page, 'Create your first organization')).toBeVisible();
    const cookie = (await context.cookies()).find((entry) => entry.name === 'agentos_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate<string>('document.cookie')).not.toContain('agentos_session');

    // 4. The first organization.
    await page.getByLabel('Organization name').fill('Zoe Labs');
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}\/projects$/);
    const ownOrganization = /\/organizations\/([0-9a-f-]{36})\//.exec(page.url())?.[1] ?? '';
    await expect(pageHeading(page, 'Projects')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Organization: Zoe Labs' })).toBeVisible();

    // 5. The first project. The slug follows the name until the person edits it.
    await page.getByRole('main').getByRole('button', { name: 'Create project' }).click();
    const form = page.getByRole('dialog', { name: 'Create a project' });
    await form.getByLabel('Name', { exact: true }).fill('Platform Rewrite');
    await expect(form.getByLabel('Slug')).toHaveValue('platform-rewrite');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(pageHeading(page, 'Platform Rewrite')).toBeVisible();
    await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}$/);

    // 6. Another organization is "not found" (the person is not a member), and so is its project under the person's own organization,
    //    exactly as a project that does not exist. Nothing about either appears on the page.
    const unreachable: [string, string][] = [
      [projectPath(world.organizationId, secret.id), 'Organization not found'], // the organization's address: not a member
      [projectPath(ownOrganization, secret.id), 'Project not found'], // somebody else's project under the person's own address
      [projectPath(ownOrganization, '00000000-0000-4000-8000-000000000000'), 'Project not found'], // no such project at all
    ];
    for (const [path, message] of unreachable) {
      await page.goto(path);
      await expect(page.getByText(message)).toBeVisible();
      await expect(page.getByText('Secret Plans')).toHaveCount(0);
      await expect(page.getByText(world.organizationName)).toHaveCount(0);
    }
  });

  test('signing in from an address the API does not allow says so, and nothing is signed in', async ({
    page,
    context,
    stack,
  }) => {
    // The API accepts the state-changing requests of a browser only from its configured origin (http://localhost:<port>). The same
    // server opened by its numeric address is another origin: the sign-in is refused, and the page names the cause.
    const { ada } = stack.people;
    await page.goto(`http://127.0.0.1:${new URL(stack.webOrigin).port}/sign-in`);
    await page.getByLabel('Email', { exact: true }).fill(ada.email);
    await page.getByLabel('Password', { exact: true }).fill(ada.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(/This web address is not allowed to sign in/)).toBeVisible();
    await expect(pageHeading(page, 'Sign in')).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === 'agentos_session')).toBe(false);
  });
});
