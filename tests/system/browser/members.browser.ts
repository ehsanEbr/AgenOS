import type { BrowserContext, Page } from '@playwright/test';
import { newWorld, type Api } from './support/api';
import type { StackInfo } from './support/stack-info';
import { expectIdleDismissal, expectProtectedWhileRunning } from './support/dialogs';
import { expect, membersPath, signInThroughTheApi, test } from './fixtures';

/*
 * Project member management through the real application (ADR-0012 D1, D5; step 6): add from the organization's members, change a role,
 * remove, and the self-removal warning. The organization and its people are set up through the API; the behavior under test goes through
 * the UI, and every change is checked against what the SERVER now says (a hidden or shown control is never the proof).
 */

test.describe('managing the members of a project', () => {
  /**
   * An organization owned by Ada, with Bob as a member and Cara as a viewer, and a project. Whoever creates a project becomes its first
   * explicit project admin; an organization owner who did not create it reaches it through the organization and is not a member row.
   */
  async function setup({ stack, api }: { stack: StackInfo; api: Api }, creator: 'ada' | 'bob' = 'ada') {
    const { ada, bob, cara } = stack.people;
    const world = await newWorld(api, ada, [
      { person: bob, role: 'member' },
      { person: cara, role: 'viewer' },
    ]);
    const project = await api.createProject(
      stack.people[creator],
      world.organizationId,
      `Apollo ${world.tag}`,
      `apollo-${world.tag}`,
    );
    return { ...world, project, ada, bob, cara };
  }

  test('adds a member from the organization, changes the role, and removes them: the server agrees at every step', async ({
    page,
    context,
    stack,
    api,
  }) => {
    // Bob created the project, so he is its project admin. Ada owns the organization: she reaches the project through it, holds no
    // project role, and is not a row of the members table.
    const { organizationId, project, ada, bob, cara } = await setup({ stack, api }, 'bob');
    await signInThroughTheApi(context, stack, ada);
    await page.goto(membersPath(organizationId, project.id));
    await expect(page.getByRole('row', { name: new RegExp(bob.name) })).toContainText('Project admin');
    await expect(page.getByRole('row', { name: new RegExp(ada.name) })).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('button', { name: 'Add member' })).toBeEnabled();

    // Add Cara from the picker. Bob is a member already and cannot be chosen again.
    await page.getByRole('main').getByRole('button', { name: 'Add member' }).click();
    const picker = page.getByRole('dialog', { name: 'Add a member' });
    await expect(picker.getByText(/Showing 3 of 3 organization members/)).toBeVisible();
    await expect(picker.getByRole('radio', { name: new RegExp(`^${bob.name} \\(`) })).toBeDisabled();
    await expect(picker.getByText('Already a member')).toBeVisible();
    await picker.getByRole('radio', { name: new RegExp(`^${cara.name} \\(`) }).check();
    await expect(picker.getByRole('radio', { name: 'Project member' })).toBeChecked(); // the default role
    await picker.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByText('Member added')).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(cara.name) });
    await expect(row).toContainText('Project member');
    const asCara = await api.call(`/projects/${project.id}`, { token: cara.token });
    expect(asCara.status, 'an organization viewer now reaches the project').toBe(200);
    expect(asCara.body).toMatchObject({ projectRole: 'project_member' });

    // She cannot edit it yet: a project member holds no `project.update`.
    const edit = () =>
      api.call(`/projects/${project.id}`, {
        token: cara.token,
        method: 'PATCH',
        body: { description: 'by Cara' },
      });
    expect((await edit()).status).toBe(403);

    // Change the role to project admin: the server now lets her edit.
    await page.getByRole('button', { name: `Change role of ${cara.name}` }).click();
    const change = page.getByRole('dialog', { name: `Change the role of ${cara.name}` });
    await change.getByRole('radio', { name: 'Project admin' }).check();
    await change.getByRole('button', { name: 'Save role' }).click();
    await expect(page.getByText('Role changed')).toBeVisible();
    await expect(row).toContainText('Project admin');
    expect((await edit()).status).toBe(200);

    // Remove her. She loses her explicit role, and with it her access: she is an ordinary member of the organization.
    await page.getByRole('button', { name: `Remove ${cara.name}` }).click();
    const confirm = page.getByRole('dialog', { name: `Remove ${cara.name} from this project?` });
    await expect(
      confirm.getByText(/An ordinary organization member then loses access to this project/),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove member' }).click();
    await expect(page.getByText('Member removed')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(cara.name) })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(bob.name) })).toBeVisible(); // Bob is untouched
    const gone = await api.call(`/projects/${project.id}`, { token: cara.token });
    expect(gone.status, 'the same answer as for a project that does not exist').toBe(404);
    expect(gone.body).toMatchObject({ code: 'project_not_found' });
  });

  test('an organization owner who removes their own project role keeps access, and the dialog says so', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { organizationId, project, ada } = await setup({ stack, api });
    await signInThroughTheApi(context, stack, ada);
    await page.goto(membersPath(organizationId, project.id));

    const own = page.getByRole('row', { name: new RegExp(ada.name) });
    await expect(own).toContainText('You');
    await page.getByRole('button', { name: `Remove ${ada.name}` }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove yourself from this project?' });
    await expect(
      confirm.getByText(/you keep access to this project through your organization role/),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove member' }).click();
    await expect(page.getByText('Member removed')).toBeVisible();

    // Still on the project: access comes from the organization role.
    await expect(page.getByRole('heading', { level: 1, name: project.name })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(ada.name) })).toHaveCount(0);
    expect((await api.call(`/projects/${project.id}`, { token: ada.token })).status).toBe(200);
  });

  test('a project admin who is an ordinary organization member loses access by removing themselves, and is told first', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { organizationId, project, ada, bob } = await setup({ stack, api });
    await api.addProjectMember(ada, project.id, bob, 'project_admin');
    await signInThroughTheApi(context, stack, bob);
    await page.goto(membersPath(organizationId, project.id));

    await page.getByRole('button', { name: `Remove ${bob.name}` }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove yourself from this project?' });
    await expect(confirm.getByText(/You will lose access to this project/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove member' }).click();

    // The project is now "not found" to him, exactly as to anyone without access.
    await expect(page.getByText('Project not found')).toBeVisible();
    expect((await api.call(`/projects/${project.id}`, { token: bob.token })).status).toBe(404);
  });
});

/*
 * The member dialogs in a real browser: Escape, a click on the mask, the close button and Cancel (support/dialogs.ts). The component
 * tests can only check the props these dialogs give to Ant Design's `Modal`.
 */
test.describe('the member dialogs', () => {
  async function prepare({
    stack,
    api,
    context,
    page,
  }: {
    stack: StackInfo;
    api: Api;
    context: BrowserContext;
    page: Page;
  }) {
    const { ada, bob } = stack.people;
    const world = await newWorld(api, ada, [
      { person: bob, role: 'member' },
      { person: stack.people.cara, role: 'viewer' }, // the add dialog picks her
    ]);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Dialogs ${world.tag}`,
      `dialogs-${world.tag}`,
    );
    await api.addProjectMember(ada, project.id, bob, 'project_member');
    await signInThroughTheApi(context, stack, ada);
    await page.goto(membersPath(world.organizationId, project.id));
    await expect(page.getByRole('row', { name: /Bob Builder/ })).toBeVisible();
    return { project, bob };
  }

  test('the add dialog', async ({ page, context, stack, api }) => {
    const { project } = await prepare({ stack, api, context, page });
    const open = () => page.getByRole('main').getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a member' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await dialog.getByRole('radio', { name: new RegExp(`^${stack.people.cara.name} \\(`) }).check();
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Add member' }),
      cancel,
      {
        method: 'POST',
        url: new RegExp(`/api/v1/projects/${project.id}/members$`),
      },
    );
    await expect(page.getByText('Member added')).toBeVisible();
  });

  test('the change-role dialog', async ({ page, context, stack, api }) => {
    const { project } = await prepare({ stack, api, context, page });
    const open = () => page.getByRole('button', { name: 'Change role of Bob Builder' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change the role of Bob Builder' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await dialog.getByRole('radio', { name: 'Project viewer' }).check();
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Save role' }),
      cancel,
      {
        method: 'PATCH',
        url: new RegExp(`/api/v1/projects/${project.id}/members/`),
      },
    );
    await expect(page.getByRole('row', { name: /Bob Builder/ })).toContainText('Project viewer');
  });

  test('the remove dialog', async ({ page, context, stack, api }) => {
    const { project } = await prepare({ stack, api, context, page });
    const open = () => page.getByRole('button', { name: 'Remove Bob Builder' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove Bob Builder from this project?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });

    await open();
    await expectIdleDismissal(page, dialog, cancel, open);

    await open();
    await expectProtectedWhileRunning(
      page,
      dialog,
      dialog.getByRole('button', { name: 'Remove member' }),
      cancel,
      {
        method: 'DELETE',
        url: new RegExp(`/api/v1/projects/${project.id}/members/`),
      },
    );
    await expect(page.getByRole('row', { name: /Bob Builder/ })).toHaveCount(0);
  });
});
