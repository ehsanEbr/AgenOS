import { newWorld } from './support/api';
import {
  expect,
  membersPath,
  pageHeading,
  projectPath,
  projectsPath,
  signInThroughTheApi,
  test,
} from './fixtures';

/*
 * The UI chooses what to show and the server decides what is allowed (ADR-0012 D3, "Security considerations"). For representative roles
 * this checks that the pair AGREE in a real browser: a control that is hidden is also refused by the API when its request is sent anyway.
 * Hidden controls are not a security boundary; these tests are where both halves are seen together.
 */

test.describe('what each role sees, and what the server allows', () => {
  test('a project viewer sees the project and the members, no write control, and the API refuses the writes', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { ada, cara } = stack.people;
    const world = await newWorld(api, ada, [{ person: cara, role: 'viewer' }]);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Viewed ${world.tag}`,
      `viewed-${world.tag}`,
    );
    await api.addProjectMember(ada, project.id, cara, 'project_viewer');
    await signInThroughTheApi(context, stack, cara);

    // The project and its members can be read.
    await page.goto(projectPath(world.organizationId, project.id));
    await expect(pageHeading(page, `Viewed ${world.tag}`)).toBeVisible();
    await expect(page.getByText('Project viewer')).toBeVisible();
    // ... and none of the write controls is on the page.
    for (const name of ['Edit', 'Archive', 'Restore'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.goto(membersPath(world.organizationId, project.id));
    await expect(page.getByRole('row', { name: new RegExp(cara.name) })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toHaveCount(0);
    await page.goto(projectsPath(world.organizationId));
    await expect(page.getByRole('row', { name: new RegExp(`Viewed ${world.tag}`) })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project' })).toHaveCount(0);

    // The same requests, sent anyway with this person's real session cookie, are refused by the server.
    const send = (path: string, method: string, data?: unknown) =>
      context.request.fetch(`${stack.webOrigin}/api/v1${path}`, {
        method,
        headers: { origin: stack.webOrigin },
        ...(data === undefined ? {} : { data }),
      });
    const edit = await send(`/projects/${project.id}`, 'PATCH', { name: 'Hijacked' });
    expect(edit.status()).toBe(403);
    expect(await edit.json()).toMatchObject({ code: 'forbidden' });
    expect((await send(`/projects/${project.id}/archive`, 'POST')).status()).toBe(403);
    expect(
      (
        await send(`/projects/${project.id}/members`, 'POST', {
          userId: cara.id,
          projectRole: 'project_admin',
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await send('/projects', 'POST', {
          organizationId: world.organizationId,
          name: 'Mine',
          slug: `mine-${world.tag}`,
        })
      ).status(),
    ).toBe(403);

    // Nothing changed.
    const unchanged = await api.call<{ name: string }>(`/projects/${project.id}`, { token: ada.token });
    expect(unchanged.body.name).toBe(`Viewed ${world.tag}`);
  });

  test('an organization viewer with no project role cannot see the project at all', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { ada, cara } = stack.people;
    const world = await newWorld(api, ada, [{ person: cara, role: 'viewer' }]);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Hidden ${world.tag}`,
      `hidden-${world.tag}`,
    );
    await signInThroughTheApi(context, stack, cara);

    await page.goto(projectsPath(world.organizationId));
    await expect(page.getByText('There are no active projects that you can open.')).toBeVisible();
    await expect(page.getByText(`Hidden ${world.tag}`)).toHaveCount(0);

    await page.goto(projectPath(world.organizationId, project.id));
    await expect(page.getByText('Project not found')).toBeVisible();
    await expect(page.getByText(`Hidden ${world.tag}`)).toHaveCount(0);
    const response = await context.request.get(`${stack.webOrigin}/api/v1/projects/${project.id}`);
    expect(response.status(), 'the same answer as for a project that does not exist').toBe(404);
    expect(await response.json()).toMatchObject({ code: 'project_not_found' });
  });

  test('a project member can work with the project but not manage it; an organization member can create projects', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { ada, bob } = stack.people;
    const world = await newWorld(api, ada, [{ person: bob, role: 'member' }]);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Shared ${world.tag}`,
      `shared-${world.tag}`,
    );
    await api.addProjectMember(ada, project.id, bob, 'project_member');
    await signInThroughTheApi(context, stack, bob);

    await page.goto(projectsPath(world.organizationId));
    await expect(page.getByRole('main').getByRole('button', { name: 'Create project' })).toBeVisible(); // organization members may create
    await page.goto(projectPath(world.organizationId, project.id));
    await expect(pageHeading(page, `Shared ${world.tag}`)).toBeVisible();
    for (const name of ['Edit', 'Archive'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0); // project.update and project.archive need a project admin
    await page.goto(membersPath(world.organizationId, project.id));
    await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);

    const edit = await context.request.patch(`${stack.webOrigin}/api/v1/projects/${project.id}`, {
      headers: { origin: stack.webOrigin },
      data: { name: 'Hijacked' },
    });
    expect(edit.status()).toBe(403);
  });

  test('a role taken away is noticed by the page on its next write: the controls go and the person is told', async ({
    page,
    context,
    stack,
    api,
  }) => {
    const { ada, bob } = stack.people;
    const world = await newWorld(api, ada, [{ person: bob, role: 'member' }]);
    const project = await api.createProject(
      ada,
      world.organizationId,
      `Taken ${world.tag}`,
      `taken-${world.tag}`,
    );
    await api.addProjectMember(ada, project.id, bob, 'project_admin');
    await signInThroughTheApi(context, stack, bob);
    await page.goto(projectPath(world.organizationId, project.id));
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();

    // Meanwhile the owner demotes him; this page still shows the controls it was drawn with.
    const demoted = await api.call(`/projects/${project.id}/members/${bob.id}`, {
      token: ada.token,
      method: 'PATCH',
      body: { projectRole: 'project_viewer' },
    });
    expect(demoted.status).toBe(200);

    // The server refuses the edit, and the page redraws with what he may now do.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit project' });
    await edit.getByLabel('Name', { exact: true }).fill(`Renamed ${world.tag}`);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Your access has changed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(pageHeading(page, `Taken ${world.tag}`)).toBeVisible(); // the name did not change
  });
});
