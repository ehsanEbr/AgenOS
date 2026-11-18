import type { OrganizationWithRole, OrganizationRole, Project, ProjectRole } from '@agentos/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  healthOk,
  jsonResponse,
  mockFetch,
  organizationNotFoundError,
  testOrganization,
  testProject,
  unauthenticatedError,
} from '../../test/fixtures/api';
import { renderApp } from '../../test/render';
import { organizationProjectsPath } from './paths';

/*
 * The write side of the projects UI through the real application (ADR-0012 D3, D4; step 5): create, edit, archive and restore. `fetch` is
 * the only thing faked, and the fake API behaves like the real one: the slug is unique per organization (`409 project_slug_taken`), an
 * archived project cannot be changed (`409 project_archived`), archive and restore are idempotent `200`s, and a role downgrade makes the
 * next write answer `403`. The UI only chooses what to SHOW; every assertion about authorization is about what the server was asked.
 */

// Several tests render the whole application, a table and a modal form: allow for that without hiding a real hang.
vi.setConfig({ testTimeout: 20_000 });

const pad = (n: number) => String(n).padStart(12, '0');
const orgId = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;
const projectId = (n: number) => `10000000-0000-4000-8000-${pad(n)}`;

const organization = (n: number, role: OrganizationRole = 'owner'): OrganizationWithRole => ({
  ...testOrganization,
  id: orgId(n),
  name: `Organization ${n}`,
  role,
});
const project = (n: number, over: Partial<Project> = {}): Project => ({
  ...testProject,
  id: projectId(n),
  organizationId: orgId(1),
  name: `Project ${n}`,
  slug: `project-${n}`,
  ...over,
});
const archivedProject = (n: number, over: Partial<Project> = {}) =>
  project(n, { status: 'archived', archivedAt: '2026-04-01T08:00:00.000Z', ...over });

const err = (status: number, code: string) => () =>
  jsonResponse({ code, message: 'server text that must never be shown', correlationId: 'srv-w1' }, status);
const slugTaken = err(409, 'project_slug_taken');
const archivedError = err(409, 'project_archived');
const forbidden = err(403, 'forbidden');
const notFound = err(404, 'project_not_found');
const internal = err(500, 'internal_error');
const validation = () =>
  jsonResponse(
    {
      code: 'validation_error',
      message: 'server text that must never be shown',
      details: [{ path: 'name', message: 'Too long' }],
      correlationId: 'srv-w2',
    },
    400,
  );

type Reply = Response | Promise<Response>;
interface Fake {
  organizations?: OrganizationWithRole[];
  projects: Project[];
  /** Each override gets the request and returns a reply, or `undefined` to fall through to the fake server's own behavior. */
  onCreate?: (body: Record<string, unknown>) => Reply | undefined;
  onUpdate?: (id: string, body: Record<string, unknown>) => Reply | undefined;
  onArchive?: (id: string) => Reply | undefined;
  onRestore?: (id: string) => Reply | undefined;
  organizationDetail?: (id: string) => Reply | undefined;
}

function api(fake: Fake) {
  return mockFetch(({ url, init }) => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const orgs = () => fake.organizations ?? [organization(1)];
    const body = () => (init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    const page = (items: unknown[]) => {
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse({
        items: items.slice(offset, offset + limit),
        page: { limit, offset, total: items.length },
      });
    };

    if (path === '/health') return jsonResponse(healthOk);
    if (path === '/auth/logout') return new Response(null, { status: 204 });
    if (path === '/organizations' && method === 'GET') return page(orgs());
    const org = /^\/organizations\/([^/]+)$/.exec(path);
    if (org) {
      const id = decodeURIComponent(org[1]!);
      const override = fake.organizationDetail?.(id);
      if (override) return override;
      const found = orgs().find((o) => o.id === id);
      return found ? jsonResponse(found) : jsonResponse(organizationNotFoundError, 404);
    }

    if (path === '/projects' && method === 'GET') {
      const status = url.searchParams.get('status');
      return page(
        fake.projects.filter(
          (p) =>
            p.organizationId === url.searchParams.get('organizationId') &&
            (status === 'all' || p.status === status),
        ),
      );
    }
    if (path === '/projects' && method === 'POST') {
      const request = body();
      const override = fake.onCreate?.(request);
      if (override) return override;
      if (fake.projects.some((p) => p.organizationId === request.organizationId && p.slug === request.slug))
        return slugTaken();
      const created: Project = {
        ...testProject,
        id: projectId(500 + fake.projects.length),
        organizationId: String(request.organizationId),
        name: String(request.name).trim(),
        slug: String(request.slug),
        description: typeof request.description === 'string' ? request.description : null,
        projectRole: 'project_admin',
      };
      fake.projects.push(created);
      return jsonResponse(created, 201);
    }

    const action = /^\/projects\/([^/]+)\/(archive|restore)$/.exec(path);
    if (action && method === 'POST') {
      const id = decodeURIComponent(action[1]!);
      const override = action[2] === 'archive' ? fake.onArchive?.(id) : fake.onRestore?.(id);
      if (override) return override;
      const found = fake.projects.find((p) => p.id === id);
      if (!found) return notFound();
      if (action[2] === 'archive')
        Object.assign(found, { status: 'archived', archivedAt: '2026-05-01T10:00:00.000Z' });
      else Object.assign(found, { status: 'active', archivedAt: null });
      return jsonResponse(found);
    }
    const one = /^\/projects\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      const found = fake.projects.find((p) => p.id === id);
      if (method === 'PATCH') {
        const request = body();
        const override = fake.onUpdate?.(id, request);
        if (override) return override;
        if (!found) return notFound();
        if (found.status === 'archived') return archivedError();
        if (typeof request.name === 'string') found.name = request.name;
        if ('description' in request) found.description = request.description as string | null;
        return jsonResponse(found);
      }
      return found ? jsonResponse(found) : notFound();
    }
    if (/\/members$/.test(path)) return page([]);
    return jsonResponse({ code: 'not_found', message: 'x', correlationId: 'c' }, 404);
  });
}

const calls = (spy: ReturnType<typeof mockFetch>, method: string, test: (path: string) => boolean) =>
  spy.mock.calls.filter(([url, init]) => {
    const path = new URL(String(url), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    return ((init as RequestInit | undefined)?.method ?? 'GET') === method && test(path);
  });
const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
const createCalls = (spy: ReturnType<typeof mockFetch>) => calls(spy, 'POST', (p) => p === '/projects');
const updateCalls = (spy: ReturnType<typeof mockFetch>, id: string) =>
  calls(spy, 'PATCH', (p) => p === `/projects/${id}`);
const archiveCalls = (spy: ReturnType<typeof mockFetch>, id: string) =>
  calls(spy, 'POST', (p) => p === `/projects/${id}/archive`);
const restoreCalls = (spy: ReturnType<typeof mockFetch>, id: string) =>
  calls(spy, 'POST', (p) => p === `/projects/${id}/restore`);
const listCalls = (spy: ReturnType<typeof mockFetch>, org = orgId(1)) =>
  calls(spy, 'GET', (p) => p === '/projects').filter(([url]) =>
    String(url).includes(`organizationId=${org}`),
  );
const orgRoleCalls = (spy: ReturnType<typeof mockFetch>, org = orgId(1)) =>
  calls(spy, 'GET', (p) => p === `/organizations/${org}`);

/** The organization role is read twice (the organization route, then this feature's own query): wait until both have been asked and answered. */
const rolesKnown = async (spy: ReturnType<typeof mockFetch>) => {
  await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThanOrEqual(2));
  await act(settled);
};

const LIST = organizationProjectsPath(orgId(1));
const DETAILS = (n: number) => `${LIST}/${projectId(n)}`;
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const settled = () => new Promise<void>((done) => setTimeout(done, 0));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
// Ant Design labels every dialog with the same id under test, so the dialog is found by role and its title is checked by text.
const dialog = async (title: string) => {
  const found = await screen.findByRole('dialog');
  await within(found).findAllByText(title); // a title can equal the confirm button's label (Persian)
  return found;
};
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
const fill = (scope: ReturnType<typeof within>, label: string, value: string) =>
  fireEvent.change(scope.getByLabelText(label), { target: { value } });
const submitForm = (scope: ReturnType<typeof within>) =>
  fireEvent.submit(scope.getByLabelText('Name').closest('form')!);
const shown = async (name: string) => within(await screen.findByRole('main')).queryByRole('button', { name });

// ---------------------------------------------------------------------------------------------------------------------------------

describe('which controls are shown (the permission helper, ADR-0012 D3)', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['viewer', false],
  ] as const)('the list offers "Create project" to an organization %s: %s', async (role, offered) => {
    const spy = api({
      organizations: [organization(1, role)],
      projects: [project(1, { projectRole: 'project_viewer' })],
    });
    renderApp(LIST);

    await screen.findByRole('row', { name: /^Project 1 / });
    await rolesKnown(spy);
    expect(!!(await shown('Create project'))).toBe(offered);
  });

  it('offers nothing until the organization role is known (fail closed), then offers what the role allows', async () => {
    const pending = deferred<Response>();
    let asked = 0;
    const spy = api({
      projects: [project(1)],
      // The first request is the organization route's; the second is this feature's own query, which is held back.
      organizationDetail: () => (++asked === 2 ? pending.promise : undefined),
    });
    renderApp(DETAILS(1));

    await heading('Project 1');
    await waitFor(() => expect(orgRoleCalls(spy).length).toBe(2));
    await act(settled);
    expect(await shown('Edit')).toBeNull(); // the page is readable, but no control is offered on a guess
    expect(await shown('Archive')).toBeNull();

    pending.resolve(jsonResponse(organization(1)));
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('shows no control when the organization role cannot be read; the page stays readable', async () => {
    let asked = 0;
    const spy = api({
      projects: [project(1)],
      organizationDetail: () => (++asked === 1 ? undefined : internal()),
    });
    renderApp(DETAILS(1));

    await heading('Project 1');
    await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThanOrEqual(2));
    await act(settled);
    expect(await shown('Edit')).toBeNull();
    expect(await shown('Archive')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Project 1' })).toBeInTheDocument();
  });

  const MATRIX: [OrganizationRole, ProjectRole | null, boolean][] = [
    ['owner', null, true],
    ['admin', null, true],
    ['member', null, false], // an organization member reaches a project only through a project role
    ['viewer', null, false],
    ['owner', 'project_viewer', true],
    ['admin', 'project_member', true],
    ['member', 'project_admin', true], // a project role adds project-scoped actions
    ['viewer', 'project_admin', true],
    ['member', 'project_member', false],
    ['member', 'project_viewer', false],
    ['viewer', 'project_member', false],
    ['viewer', 'project_viewer', false],
  ];

  it.each(MATRIX)(
    'an ACTIVE project: organization %s with project role %s -> edit and archive offered: %s, restore never',
    async (role, projectRole, holdsWrite) => {
      const spy = api({ organizations: [organization(1, role)], projects: [project(1, { projectRole })] });
      renderApp(DETAILS(1));

      await heading('Project 1');
      await rolesKnown(spy);
      expect(!!(await shown('Edit'))).toBe(holdsWrite);
      expect(!!(await shown('Archive'))).toBe(holdsWrite);
      expect(await shown('Restore')).toBeNull();
      if (holdsWrite) expect(await shown('Edit')).toBeEnabled();
    },
  );

  it.each(MATRIX)(
    'an ARCHIVED project: organization %s with project role %s -> Edit visible but disabled with the reason, Archive never, Restore offered: %s',
    async (role, projectRole, holdsWrite) => {
      const spy = api({
        organizations: [organization(1, role)],
        projects: [archivedProject(1, { projectRole })],
      });
      renderApp(DETAILS(1));

      await heading('Project 1');
      await rolesKnown(spy);
      const edit = await shown('Edit');
      expect(!!edit).toBe(holdsWrite);
      if (edit) {
        expect(edit).toBeDisabled();
        expect(
          screen.getByTitle('An archived project cannot be edited. Restore it first.'),
        ).toBeInTheDocument();
      }
      expect(await shown('Archive')).toBeNull();
      expect(!!(await shown('Restore'))).toBe(holdsWrite);
    },
  );

  it('does not offer to edit an archived project even by clicking: the modal never opens', async () => {
    api({ projects: [archivedProject(1)] });
    renderApp(DETAILS(1));

    await heading('Project 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await act(settled);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('creating a project', () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    return within(await dialog('Create a project'));
  };

  it('suggests the slug from the name until the person writes their own, and resumes when the slug is cleared', async () => {
    api({ projects: [] });
    renderApp(LIST);
    const form = await open();

    fill(form, 'Name', 'Platform Rewrite');
    expect(form.getByLabelText('Slug')).toHaveValue('platform-rewrite');
    fill(form, 'Name', 'Platform Rewrite 2');
    expect(form.getByLabelText('Slug')).toHaveValue('platform-rewrite-2');

    fill(form, 'Slug', 'my-own');
    fill(form, 'Name', 'Something Else');
    expect(form.getByLabelText('Slug')).toHaveValue('my-own'); // no longer follows the name

    fill(form, 'Slug', '');
    fill(form, 'Name', 'Fresh Start');
    expect(form.getByLabelText('Slug')).toHaveValue('fresh-start'); // follows again
  });

  it('says the slug cannot be changed later, and offers no field that the API would refuse', async () => {
    api({ projects: [] });
    renderApp(LIST);
    const form = await open();

    expect(form.getByText(/It cannot be changed later/)).toBeInTheDocument();
    expect(form.getByLabelText('Description (optional)')).toBeInTheDocument();
    expect(form.queryByLabelText(/organization/i)).toBeNull(); // the organization comes from the URL
  });

  it('checks the fields before sending anything, with translated messages', async () => {
    const spy = api({ projects: [] });
    renderApp(LIST);
    const form = await open();

    fireEvent.click(form.getByRole('button', { name: 'Create project' }));
    expect(await form.findByText('Enter a name for the project.')).toBeInTheDocument();
    expect(form.getByText('Enter a slug.')).toBeInTheDocument();

    fill(form, 'Name', 'Ok');
    fill(form, 'Slug', 'Not Valid');
    fill(form, 'Description (optional)', 'd'.repeat(2001));
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));
    expect(await form.findByText('Use lower-case letters, digits and single hyphens.')).toBeInTheDocument();
    expect(form.getByText('Use at most 2000 characters.')).toBeInTheDocument();
    expect(createCalls(spy)).toHaveLength(0);
  });

  it('creates the project, announces it, and opens its page; the lists of that organization are refetched', async () => {
    const fake: Fake = { projects: [project(1)] };
    const spy = api(fake);
    const { router } = renderApp(LIST);
    await screen.findByRole('row', { name: /^Project 1 / });
    const listRequestsBefore = listCalls(spy).length;
    const form = await open();

    fill(form, 'Name', '  Brand New  ');
    fill(form, 'Description (optional)', '  Some words  ');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    expect(await heading('Brand New')).toBeInTheDocument();
    const created = fake.projects.at(-1)!;
    expect(router.state.location.pathname).toBe(`${LIST}/${created.id}`);
    expect(createCalls(spy)).toHaveLength(1);
    expect(bodyOf(createCalls(spy)[0]!)).toEqual({
      organizationId: orgId(1), // from the URL
      name: 'Brand New',
      slug: 'brand-new',
      description: 'Some words',
    });
    expect(await screen.findByText('Project created')).toBeInTheDocument();
    await closed();

    // The list was invalidated: coming back refetches it and shows the new project.
    await act(() => router.navigate(LIST));
    expect(await screen.findByRole('row', { name: /^Brand New / })).toBeInTheDocument();
    expect(listCalls(spy).length).toBeGreaterThan(listRequestsBefore);
  });

  it('omits an empty description instead of sending an empty string', async () => {
    const spy = api({ projects: [] });
    renderApp(LIST);
    const form = await open();

    fill(form, 'Name', 'No Words');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    await heading('No Words');
    expect(bodyOf(createCalls(spy)[0]!)).not.toHaveProperty('description');
  });

  it('only refetches the lists of the organization it created in', async () => {
    const spy = api({
      organizations: [organization(1), organization(2)],
      projects: [project(1), project(2, { organizationId: orgId(2) })],
    });
    const { router, queryClient } = renderApp(organizationProjectsPath(orgId(2)));
    await screen.findByRole('row', { name: /^Project 2 / });
    await act(() => router.navigate(LIST));
    await screen.findByRole('row', { name: /^Project 1 / });
    const otherBefore = listCalls(spy, orgId(2)).length;
    const ownBefore = listCalls(spy, orgId(1)).length;
    const form = await open();

    fill(form, 'Name', 'Elsewhere Not');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));
    await heading('Elsewhere Not');

    // The list that was open was refetched at once; the other organization's cached list was not touched at all.
    expect(listCalls(spy, orgId(1)).length).toBeGreaterThan(ownBefore);
    expect(listCalls(spy, orgId(2))).toHaveLength(otherBefore);
    const state = (org: string) => queryClient.getQueryState(['projects', 'list', org, 'active', 0]);
    expect(state(orgId(2))?.isInvalidated).toBe(false);
  });

  it('shows a taken slug on the slug field, stays open, and creates nothing', async () => {
    const fake: Fake = { projects: [project(1, { slug: 'taken-one' })] };
    const spy = api(fake);
    const { router } = renderApp(LIST);
    const form = await open();

    fill(form, 'Name', 'Another');
    fill(form, 'Slug', 'taken-one');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    expect(
      await form.findByText('Another project in this organization already uses this slug.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
    expect(router.state.location.pathname).toBe(LIST);
    expect(fake.projects).toHaveLength(1);

    fill(form, 'Slug', 'free-one'); // the person fixes it and tries again
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));
    await heading('Another');
    expect(createCalls(spy)).toHaveLength(2);
  });

  it('puts a server-side validation failure on the field it names, in translated text', async () => {
    api({ projects: [], onCreate: () => validation() });
    renderApp(LIST);
    const form = await open();

    fill(form, 'Name', 'Valid Locally');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    expect(await form.findByText('This value is not valid.')).toBeInTheDocument();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
  });

  it('sends ONE request when submitted twice in the same tick', async () => {
    const answer = deferred<Response>();
    const fake: Fake = { projects: [], onCreate: () => answer.promise };
    const spy = api(fake);
    renderApp(LIST);
    const form = await open();
    fill(form, 'Name', 'Once Only');

    act(() => {
      submitForm(form);
      submitForm(form);
      submitForm(form);
    });
    await waitFor(() => expect(createCalls(spy)).toHaveLength(1));
    await act(settled);
    expect(createCalls(spy)).toHaveLength(1);
    const created = {
      ...testProject,
      id: projectId(900),
      organizationId: orgId(1),
      name: 'Once Only',
      slug: 'once-only',
    };
    fake.projects.push(created);
    answer.resolve(jsonResponse(created, 201));
    await heading('Once Only');
    expect(createCalls(spy)).toHaveLength(1);
  });

  it('cannot be closed while the request runs, and a second activation (button or Enter) sends nothing', async () => {
    const answer = deferred<Response>();
    const fake: Fake = { projects: [], onCreate: () => answer.promise };
    const spy = api(fake);
    renderApp(LIST);
    const form = await open();
    fill(form, 'Name', 'Slow One');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(createCalls(spy)).toHaveLength(1));

    expect(form.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // While it runs, the confirm button shows a spinner and its name changes: match it by what it says.
    fireEvent.click(form.getByRole('button', { name: /Create project/ }));
    // Pressing Enter in a field submits the form without going through the button, which the spinner does not block.
    submitForm(form);
    await act(settled);
    submitForm(form);
    await act(settled);
    expect(createCalls(spy)).toHaveLength(1);
    const created = {
      ...testProject,
      id: projectId(901),
      organizationId: orgId(1),
      name: 'Slow One',
      slug: 'slow-one',
    };
    fake.projects.push(created);
    answer.resolve(jsonResponse(created, 201));
    await heading('Slow One');
  });

  it('Cancel closes the form without a request, and reopening starts empty', async () => {
    const spy = api({ projects: [] });
    renderApp(LIST);
    let form = await open();
    fill(form, 'Name', 'Abandoned');
    fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
    await closed();

    form = await open();
    expect(form.getByLabelText('Name')).toHaveValue('');
    expect(form.getByLabelText('Slug')).toHaveValue('');
    expect(createCalls(spy)).toHaveLength(0);
  });

  it.each([
    ['a 403 (the role was downgraded)', forbidden],
    ["a 404 (the organization is no longer the caller's)", err(404, 'organization_not_found')],
  ])(
    '%s means "your access changed": the form closes, the role is refetched, and the control is gone',
    async (_, answer) => {
      const fake: Fake = {
        organizations: [organization(1, 'member')],
        projects: [project(1)],
        onCreate: () => answer(),
      };
      const spy = api(fake);
      renderApp(LIST);
      const form = await open();
      const roleRequests = orgRoleCalls(spy).length;

      fake.organizations = [organization(1, 'viewer')]; // the server's truth has changed
      fill(form, 'Name', 'Too Late');
      fireEvent.click(form.getByRole('button', { name: 'Create project' }));

      expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await closed();
      await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThan(roleRequests));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull());
    },
  );

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 500', () => internal()],
  ])(
    '%s is UNCERTAIN: the form stays with a notice, the lists are refetched, and a retry cannot create a duplicate',
    async (_, failure) => {
      const fake: Fake = { projects: [project(1)] };
      let first = true;
      fake.onCreate = (request) => {
        if (!first) return undefined; // later attempts reach the fake server's own rules
        first = false;
        // The server DID create the project, and the answer was lost.
        fake.projects.push({
          ...testProject,
          id: projectId(777),
          organizationId: orgId(1),
          name: String(request.name),
          slug: String(request.slug),
        });
        return failure();
      };
      const spy = api(fake);
      renderApp(LIST);
      await screen.findByRole('row', { name: /^Project 1 / });
      const listsBefore = listCalls(spy).length;
      const form = await open();

      fill(form, 'Name', 'Maybe Created');
      fireEvent.click(form.getByRole('button', { name: 'Create project' }));

      expect(await form.findByText(/We could not confirm whether the change was made/)).toBeInTheDocument();
      expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await waitFor(() => expect(listCalls(spy).length).toBeGreaterThan(listsBefore)); // the truth is refetched

      fireEvent.click(form.getByRole('button', { name: 'Create project' })); // the person tries again
      expect(
        await form.findByText('Another project in this organization already uses this slug.'),
      ).toBeInTheDocument();
      expect(fake.projects.filter((p) => p.slug === 'maybe-created')).toHaveLength(1); // never two
    },
  );

  it('a 401 ends the session: the user is sent to sign in', async () => {
    api({ projects: [], onCreate: () => jsonResponse(unauthenticatedError, 401) });
    renderApp(LIST);
    const form = await open();
    fill(form, 'Name', 'Session Gone');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    expect(await heading('Sign in')).toBeInTheDocument();
  });

  it('renders the form in Persian', async () => {
    api({ projects: [] });
    renderApp(LIST, { preferences: { locale: 'fa' } });

    fireEvent.click(await screen.findByRole('button', { name: 'ایجاد پروژه' }));
    const form = within(await dialog('ایجاد پروژه'));
    expect(form.getByLabelText('نام')).toBeInTheDocument();
    expect(form.getByLabelText('شناسه کوتاه')).toBeInTheDocument();
    fill(form, 'نام', 'پروژه');
    expect(form.getByLabelText('شناسه کوتاه')).toHaveValue(''); // no Latin letters: no suggestion, never an invalid slug
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('editing a project', () => {
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    return within(await dialog('Edit project'));
  };

  it('is prefilled, offers only the name and the description (never the slug), and sends only what changed', async () => {
    const fake: Fake = { projects: [project(1, { name: 'Old Name', description: 'Old words' })] };
    const spy = api(fake);
    renderApp(DETAILS(1));
    await heading('Old Name');
    const form = await open();

    expect(form.getByLabelText('Name')).toHaveValue('Old Name');
    expect(form.getByLabelText('Description (optional)')).toHaveValue('Old words');
    expect(form.queryByLabelText('Slug')).toBeNull();

    fill(form, 'Name', '  New Name ');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await heading('New Name')).toBeInTheDocument(); // the project was refetched before the success was announced
    expect(await screen.findByText('Project updated')).toBeInTheDocument();
    expect(updateCalls(spy, projectId(1))).toHaveLength(1);
    expect(bodyOf(updateCalls(spy, projectId(1))[0]!)).toEqual({ name: 'New Name' }); // the description did not change: not sent
    await closed();
  });

  it('removes the description with null when it is blanked', async () => {
    const spy = api({ projects: [project(1, { description: 'Remove me' })] });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    fill(form, 'Description (optional)', '   ');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Project updated');
    expect(bodyOf(updateCalls(spy, projectId(1))[0]!)).toEqual({ description: null });
    expect(await screen.findByText('No description')).toBeInTheDocument();
  });

  it('sends nothing when nothing changed, and just closes', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await closed();
    expect(updateCalls(spy, projectId(1))).toHaveLength(0);
    expect(screen.queryByText('Project updated')).toBeNull();
  });

  it('checks the fields before sending anything', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    fill(form, 'Name', '   ');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await form.findByText('Enter a name for the project.')).toBeInTheDocument();
    fill(form, 'Name', 'x'.repeat(101));
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await form.findByText('Use at most 100 characters.')).toBeInTheDocument();
    expect(updateCalls(spy, projectId(1))).toHaveLength(0);
  });

  it('refetches the project and the lists of its organization, and nothing else (the members are untouched)', async () => {
    const spy = api({
      organizations: [organization(1), organization(2)],
      projects: [project(1), project(2, { organizationId: orgId(2) })],
    });
    const { router, queryClient } = renderApp(organizationProjectsPath(orgId(2)));
    await screen.findByRole('row', { name: /^Project 2 / });
    await act(() => router.navigate(`${LIST}/${projectId(1)}/members`));
    await screen.findByText('No one holds an explicit role on this project yet.');
    const membersBefore = calls(spy, 'GET', (p) => p.endsWith('/members')).length;
    await act(() => router.navigate(DETAILS(1)));
    await heading('Project 1');
    const form = await open();

    fill(form, 'Name', 'Renamed One');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await heading('Renamed One');

    const state = (key: readonly unknown[]) => queryClient.getQueryState(key);
    expect(state(['projects', 'detail', projectId(1)])?.isInvalidated).toBe(false); // already refetched
    expect(state(['projects', 'list', orgId(2), 'active', 0])?.isInvalidated).toBe(false); // another organization: untouched
    expect(calls(spy, 'GET', (p) => p.endsWith('/members'))).toHaveLength(membersBefore);
    expect(listCalls(spy, orgId(2))).toHaveLength(1);
  });

  it('shows the new name in the list afterwards', async () => {
    api({ projects: [project(1)] });
    const { router } = renderApp(LIST);
    await screen.findByRole('row', { name: /^Project 1 / });
    await act(() => router.navigate(DETAILS(1)));
    await heading('Project 1');
    const form = await open();

    fill(form, 'Name', 'Listed Anew');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));
    await heading('Listed Anew');
    await act(() => router.navigate(LIST));

    expect(await screen.findByRole('row', { name: /^Listed Anew / })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /^Project 1 / })).toBeNull();
  });

  it('a project archived meanwhile answers 409: the form closes, the project is refetched and shown read-only', async () => {
    const fake: Fake = { projects: [project(1)] };
    api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-02T00:00:00.000Z' }); // someone else archived it
    fill(form, 'Name', 'Too Late');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('This project is archived')).toBeInTheDocument(); // the notification title
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
    await closed();
    expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('puts a server-side validation failure on the field, in translated text', async () => {
    api({ projects: [project(1)], onUpdate: () => validation() });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    fill(form, 'Name', 'Fine Locally');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await form.findByText('This value is not valid.')).toBeInTheDocument();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
  });

  it.each([
    ['403', forbidden],
    ['404', notFound],
  ])('a %s means "your access changed": the role is refetched and the form closes', async (_, answer) => {
    const fake: Fake = {
      organizations: [organization(1, 'admin')],
      projects: [project(1, { projectRole: null })],
    };
    fake.onUpdate = () => answer();
    const spy = api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();
    const roleRequests = orgRoleCalls(spy).length;

    fake.organizations = [organization(1, 'viewer')];
    fill(form, 'Name', 'Not Allowed');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
    await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThan(roleRequests));
    await closed();
  });

  it('a 403 after a role downgrade removes Edit, Archive and Restore from the page', async () => {
    const fake: Fake = { organizations: [organization(1, 'admin')], projects: [project(1)] };
    fake.onUpdate = () => forbidden();
    api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();

    fake.organizations = [organization(1, 'viewer')];
    fill(form, 'Name', 'Not Allowed');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    await waitFor(async () => {
      expect(await shown('Edit')).toBeNull();
      expect(await shown('Archive')).toBeNull();
    });
    expect(await heading('Project 1')).toBeInTheDocument(); // still readable
  });

  it('is UNCERTAIN after a network error: the form stays with a notice and the project is refetched', async () => {
    const fake: Fake = { projects: [project(1)] };
    fake.onUpdate = (_, request) => {
      fake.projects[0]!.name = String(request.name); // applied on the server, answer lost
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    const spy = api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    const detailsBefore = calls(spy, 'GET', (p) => p === `/projects/${projectId(1)}`).length;
    const form = await open();

    fill(form, 'Name', 'Applied But Unconfirmed');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await form.findByText(/We could not confirm whether the change was made/)).toBeInTheDocument();
    expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls(spy, 'GET', (p) => p === `/projects/${projectId(1)}`).length).toBeGreaterThan(
        detailsBefore,
      ),
    );
    expect(await heading('Applied But Unconfirmed')).toBeInTheDocument(); // the page shows the truth
  });

  it('sends ONE request when submitted twice in the same tick', async () => {
    const answer = deferred<Response>();
    const spy = api({ projects: [project(1)], onUpdate: () => answer.promise });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();
    fill(form, 'Name', 'Once Only');

    act(() => {
      submitForm(form);
      submitForm(form);
    });
    await waitFor(() => expect(updateCalls(spy, projectId(1))).toHaveLength(1));
    await act(settled);
    submitForm(form); // Enter again once the request is running: the form is still on screen
    await act(settled);
    expect(updateCalls(spy, projectId(1))).toHaveLength(1);
    expect(form.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    answer.resolve(jsonResponse(project(1, { name: 'Once Only' })));
    await screen.findByText('Project updated');
  });

  it('a 401 ends the session: the user is sent to sign in', async () => {
    api({ projects: [project(1)], onUpdate: () => jsonResponse(unauthenticatedError, 401) });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const form = await open();
    fill(form, 'Name', 'Session Gone');
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }));

    expect(await heading('Sign in')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('archiving and restoring a project', () => {
  const confirmArchive = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    return within(await dialog('Archive this project?'));
  };

  it('asks before archiving, and Cancel sends nothing', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const confirm = await confirmArchive();

    expect(confirm.getByText(/An archived project is read-only/)).toBeInTheDocument();
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    await closed();
    expect(archiveCalls(spy, projectId(1))).toHaveLength(0);
  });

  it('archives once confirmed: the page turns read-only and offers Restore instead of Archive', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const confirm = await confirmArchive();

    fireEvent.click(confirm.getByRole('button', { name: 'Archive project' }));

    expect(await screen.findByText('Project archived')).toBeInTheDocument();
    expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument();
    expect(archiveCalls(spy, projectId(1))).toHaveLength(1);
    await closed();
    expect(await shown('Archive')).toBeNull();
    expect(await shown('Restore')).toBeInTheDocument();
    expect(await shown('Edit')).toBeDisabled();
  });

  it('moves the project between the filters: gone from Active, present under Archived', async () => {
    api({ projects: [project(1), project(2)] });
    const { router } = renderApp(LIST);
    await screen.findByRole('row', { name: /^Project 1 / });
    await act(() => router.navigate(DETAILS(1)));
    await heading('Project 1');
    fireEvent.click((await confirmArchive()).getByRole('button', { name: 'Archive project' }));
    await screen.findByText('Project archived');

    await act(() => router.navigate(LIST));
    await screen.findByRole('row', { name: /^Project 2 / });
    expect(screen.queryByRole('row', { name: /^Project 1 / })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }));
    expect(await screen.findByRole('row', { name: /^Project 1 / })).toBeInTheDocument();
  });

  it('sends ONE request when the confirmation is activated twice', async () => {
    const answer = deferred<Response>();
    const spy = api({ projects: [project(1)], onArchive: () => answer.promise });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const confirm = await confirmArchive();
    const ok = confirm.getByRole('button', { name: 'Archive project' });

    act(() => {
      fireEvent.click(ok);
      fireEvent.click(ok);
      fireEvent.click(ok);
    });
    await waitFor(() => expect(archiveCalls(spy, projectId(1))).toHaveLength(1));
    await act(settled);
    expect(archiveCalls(spy, projectId(1))).toHaveLength(1);
    expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    answer.resolve(jsonResponse(archivedProject(1)));
    await screen.findByText('Project archived');
  });

  it('restores without a confirmation: the page is editable again', async () => {
    const spy = api({ projects: [archivedProject(1)] });
    renderApp(DETAILS(1));
    await heading('Project 1');

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('Project restored')).toBeInTheDocument();
    expect(restoreCalls(spy, projectId(1))).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText('This project is archived. It is read-only.')).toBeNull());
    expect(await shown('Edit')).toBeEnabled();
    expect(await shown('Archive')).toBeInTheDocument();
    expect(await shown('Restore')).toBeNull();
  });

  it('disables the buttons while a change runs and sends one request for a double click on Restore', async () => {
    const answer = deferred<Response>();
    const spy = api({ projects: [archivedProject(1)], onRestore: () => answer.promise });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const restore = await screen.findByRole('button', { name: 'Restore' });

    act(() => {
      fireEvent.click(restore);
      fireEvent.click(restore);
    });
    await waitFor(() => expect(restoreCalls(spy, projectId(1))).toHaveLength(1));
    await act(settled);
    expect(restoreCalls(spy, projectId(1))).toHaveLength(1);
    expect(await shown('Edit')).toBeDisabled();
    answer.resolve(jsonResponse(project(1)));
    await screen.findByText('Project restored');
  });

  it.each([
    ['archive', 'Archive'],
    ['restore', 'Restore'],
  ] as const)(
    'a 403 on %s means "your access changed": the controls are redrawn from the refetched role',
    async (change, label) => {
      const fake: Fake = {
        organizations: [organization(1, 'admin')],
        projects: [change === 'archive' ? project(1) : archivedProject(1)],
      };
      fake.onArchive = () => forbidden();
      fake.onRestore = () => forbidden();
      api(fake);
      renderApp(DETAILS(1));
      await heading('Project 1');
      fake.organizations = [organization(1, 'viewer')];

      if (change === 'archive')
        fireEvent.click((await confirmArchive()).getByRole('button', { name: 'Archive project' }));
      else fireEvent.click(await screen.findByRole('button', { name: label }));

      expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await waitFor(async () => {
        expect(await shown('Archive')).toBeNull();
        expect(await shown('Restore')).toBeNull();
      });
      await closed();
    },
  );

  it('a 404 on archive (access was removed) leaves the page as the same not-found state', async () => {
    const fake: Fake = { projects: [project(1)] };
    fake.onArchive = () => {
      fake.projects = []; // the project is no longer visible to the caller
      return notFound();
    };
    api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    fireEvent.click((await confirmArchive()).getByRole('button', { name: 'Archive project' }));

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Project 1' })).toBeNull();
  });

  it('is UNCERTAIN after a network error: the project is refetched and the page shows what the server did', async () => {
    const fake: Fake = { projects: [project(1)] };
    fake.onArchive = () => {
      Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-03T00:00:00.000Z' }); // applied, answer lost
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    fireEvent.click((await confirmArchive()).getByRole('button', { name: 'Archive project' }));

    expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
    expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument(); // the truth, refetched
    expect(await shown('Restore')).toBeInTheDocument();
  });

  it('a 500 on restore is uncertain too, and the project is refetched', async () => {
    const spy = api({ projects: [archivedProject(1)], onRestore: () => internal() });
    renderApp(DETAILS(1));
    await heading('Project 1');
    const before = calls(spy, 'GET', (p) => p === `/projects/${projectId(1)}`).length;

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls(spy, 'GET', (p) => p === `/projects/${projectId(1)}`).length).toBeGreaterThan(before),
    );
  });

  it('a 401 ends the session: the user is sent to sign in', async () => {
    api({ projects: [archivedProject(1)], onRestore: () => jsonResponse(unauthenticatedError, 401) });
    renderApp(DETAILS(1));
    await heading('Project 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await heading('Sign in')).toBeInTheDocument();
  });

  it('archive and restore are idempotent on the server: repeating either is a quiet success', async () => {
    const fake: Fake = { projects: [archivedProject(1)] };
    const spy = api(fake);
    renderApp(DETAILS(1));
    await heading('Project 1');
    // Someone else restored it first: the page still shows it archived, and Restore answers 200 with the same (active) project.
    Object.assign(fake.projects[0]!, { status: 'active', archivedAt: null });

    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('Project restored')).toBeInTheDocument();
    expect(restoreCalls(spy, projectId(1))).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText('This project is archived. It is read-only.')).toBeNull());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('scope, navigation and the session', () => {
  it('opens the new project under the organization of the page, and a project of another organization is never reachable from it', async () => {
    const fake: Fake = {
      organizations: [organization(1), organization(2)],
      projects: [project(1), project(2, { organizationId: orgId(2), name: 'Other Org Project' })],
    };
    api(fake);
    const { router } = renderApp(organizationProjectsPath(orgId(2)));
    fireEvent.click(await screen.findByRole('button', { name: 'Create project' }));
    const form = within(await dialog('Create a project'));
    fill(form, 'Name', 'In Organization Two');
    fireEvent.click(form.getByRole('button', { name: 'Create project' }));

    await heading('In Organization Two');
    expect(router.state.location.pathname.startsWith(organizationProjectsPath(orgId(2)))).toBe(true);
    expect(fake.projects.at(-1)!.organizationId).toBe(orgId(2));
  });

  it('removes the write forms and every cached project entry when the user signs out', async () => {
    api({ projects: [project(1)] });
    const { queryClient } = renderApp(DETAILS(1));
    await heading('Project 1');
    await act(settled);

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    expect(await heading('Sign in')).toBeInTheDocument();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['projects'] })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('makes no write request while the session is anonymous', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(LIST, { session: { status: 'anonymous' } });

    await heading('Sign in');
    expect(createCalls(spy)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull();
  });
});
