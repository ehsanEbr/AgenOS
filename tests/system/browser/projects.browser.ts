import { newWorld } from './support/api';
import { expectIdleDismissal, expectProtectedWhileRunning } from './support/dialogs';
import { expect, pageHeading, projectPath, projectsPath, signInThroughTheApi, test } from './fixtures';

/*
 * A project's life through the real application (ADR-0012 D1): create, edit, archive, restore, with the archived project read-only, and a
 * refresh and a deep link that keep the organization. The organization is set up through the API; the project is created through the UI.
 */

test.describe('a project owner', () => {
  test('creates, edits, archives and restores a project; an archived project is read-only; a refresh keeps the place', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const ada = stack.people.ada;
    const world = await newWorld(api, ada);
    const name = `Atlas ${world.tag}`;
    const slug = `atlas-${world.tag}`;
    await signInThroughTheApi(context, stack, ada);

    // Create.
    await page.goto(projectsPath(world.organizationId));
    await expect(page.getByText('There are no active projects that you can open.')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Create project' }).click();
    const create = page.getByRole('dialog', { name: 'Create a project' });
    await create.getByLabel('Name', { exact: true }).fill(name);
    await expect(create.getByLabel('Slug')).toHaveValue(slug);
    await create.getByLabel('Description (optional)').fill('First description');
    await create.getByRole('button', { name: 'Create project' }).click();
    await expect(pageHeading(page, name)).toBeVisible();
    await expect(page.getByText('Project created')).toBeVisible();
    const projectId = /\/projects\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    expect(projectId).not.toBe('');
    await expect(page.getByRole('main').getByText('First description')).toBeVisible();

    // Edit. The slug is fixed at creation; the name and the description change.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit project' });
    await edit.getByLabel('Name', { exact: true }).fill(`${name} v2`);
    await edit.getByLabel('Description (optional)').fill('Second description');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(pageHeading(page, `${name} v2`)).toBeVisible();
    await expect(page.getByRole('main').getByText('Second description')).toBeVisible();
    await expect(page.getByText('Project updated')).toBeVisible();

    // A refresh keeps the organization, the project and the session (a real cookie across a real reload).
    await page.reload();
    await expect(pageHeading(page, `${name} v2`)).toBeVisible();
    await expect(page.getByRole('button', { name: `Organization: ${world.organizationName}` })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(projectPath(world.organizationId, projectId));

    // Archive, after a confirmation.
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Archive this project?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Archive project' }).click();
    await expect(page.getByText('This project is archived. It is read-only.')).toBeVisible();

    // The archived project is read-only in the UI and refused by the server.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
    const refused = await api.call(`/projects/${projectId}`, {
      token: ada.token,
      method: 'PATCH',
      body: { name: 'No' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'project_archived' });

    // The list shows it under "Archived" and not under the default filter.
    await page.goto(projectsPath(world.organizationId));
    await expect(page.getByText('There are no active projects that you can open.')).toBeVisible();
    await page.getByRole('main').getByText('Archived', { exact: true }).click(); // the filter's label: its radio input is visually hidden
    await expect(page.getByRole('row', { name: new RegExp(`${name} v2`) })).toBeVisible();

    // Restore: no confirmation, the project is editable again.
    await page.goto(projectPath(world.organizationId, projectId));
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Project restored')).toBeVisible();
    await expect(page.getByText('This project is archived. It is read-only.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  });

  test('a deep link to a project works after signing in and after a reload, and Back returns to the list', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const ada = stack.people.ada;
    const world = await newWorld(api, ada);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Deep ${world.tag}`,
      `deep-${world.tag}`,
    );
    await signInThroughTheApi(context, stack, ada);

    await page.goto(projectPath(world.organizationId, project.id));
    await expect(pageHeading(page, `Deep ${world.tag}`)).toBeVisible();
    await page.reload();
    await expect(pageHeading(page, `Deep ${world.tag}`)).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Projects' })
      .click();
    // The entry point only redirects: to the last-used organization, which is this one.
    await expect(page).toHaveURL(new RegExp(`${projectsPath(world.organizationId)}$`));
    await page.goBack();
    await expect(pageHeading(page, `Deep ${world.tag}`)).toBeVisible();
  });
});

/*
 * The dialogs of a project in a real browser: Escape, a click on the mask, the close button and Cancel (support/dialogs.ts).
 */
test.describe('the project dialogs', () => {
  test('the create dialog: Escape closes it while idle, nothing dismisses it while its request runs', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const world = await newWorld(api, stack.people.ada);
    await signInThroughTheApi(context, stack, stack.people.ada);
    await page.goto(projectsPath(world.organizationId));
    const open = () => page.getByRole('main').getByRole('button', { name: 'Create project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a project' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await dialog.getByLabel('Name', { exact: true }).fill(`Held ${world.tag}`);
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Create project' }),
      cancel,
      {
        method: 'POST',
        url: /\/api\/v1\/projects$/,
      },
    );
    await expect(pageHeading(page, `Held ${world.tag}`)).toBeVisible(); // it finished: the new project's page
  });

  test('the edit dialog: Escape closes it while idle, nothing dismisses it while its request runs', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const ada = stack.people.ada;
    const world = await newWorld(api, ada);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Edit ${world.tag}`,
      `edit-${world.tag}`,
    );
    await signInThroughTheApi(context, stack, ada);
    await page.goto(projectPath(world.organizationId, project.id));
    const open = () => page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit project' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await dialog.getByLabel('Name', { exact: true }).fill(`Edited ${world.tag}`);
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Save changes' }),
      cancel,
      {
        method: 'PATCH',
        url: new RegExp(`/api/v1/projects/${project.id}$`),
      },
    );
    await expect(pageHeading(page, `Edited ${world.tag}`)).toBeVisible();
  });

  test('the archive confirmation: Escape closes it while idle, nothing dismisses it while its request runs', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const ada = stack.people.ada;
    const world = await newWorld(api, ada);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Arc ${world.tag}`,
      `arc-${world.tag}`,
    );
    await signInThroughTheApi(context, stack, ada);
    await page.goto(projectPath(world.organizationId, project.id));
    const open = () => page.getByRole('button', { name: 'Archive', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive this project?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Archive project' }),
      cancel,
      {
        method: 'POST',
        url: new RegExp(`/api/v1/projects/${project.id}/archive$`),
      },
    );
    await expect(page.getByText('This project is archived. It is read-only.')).toBeVisible();
  });
});
