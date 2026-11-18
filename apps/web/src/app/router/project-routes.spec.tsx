import type { OrganizationWithRole, Project, ProjectMember } from '@agentos/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  healthOk,
  jsonResponse,
  mockFetch,
  organizationNotFoundError,
  testOrganization,
  testProject,
  testProjectMember,
  testUser,
} from '../../test/fixtures/api';
import { renderApp } from '../../test/render';
import type { SessionValue } from '../../features/auth';
import { organizationProjectsPath } from './paths';

/*
 * The read side of the projects UI through the real application (ADR-0012 D2, D3, D5; step 4): the list, a project's details and its
 * members. `fetch` is the only thing faked, and the fake API behaves like the real one: it pages with `limit`/`offset`/`total`, filters
 * by `status`, answers a project the caller cannot see with `404 project_not_found`, and has no sorting and no search.
 */

/*
 * Timeouts. Every test here renders the whole application (shell, router, tables, dialogs) in jsdom, which is slow; the default of 5 s is
 * right for a test that takes under about 2 s and wrong for the rest. A test that was MEASURED at 2 s or more gets one of these, chosen so
 * that the timeout is at least 3 times the slowest measurement of its tier (measured with both specs running in parallel, on a development
 * machine): a slower CI machine does not fail a healthy test, and a test that hangs still fails within a minute and a half.
 *   SLOW     measured 2 to 7 s
 *   SLOWER   measured 7 to 12 s
 *   SLOWEST  measured over 12 s
 */
const SLOW = 20_000;
const SLOWER = 40_000;
const SLOWEST = 90_000;

const pad = (n: number) => String(n).padStart(12, '0');
const orgId = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;
const projectId = (n: number) => `10000000-0000-4000-8000-${pad(n)}`;
const userId = (n: number) => `20000000-0000-4000-8000-${pad(n)}`;

const organization = (n: number): OrganizationWithRole => ({
  ...testOrganization,
  id: orgId(n),
  name: `Organization ${n}`,
});
const project = (n: number, over: Partial<Project> = {}): Project => ({
  ...testProject,
  id: projectId(n),
  organizationId: orgId(1),
  name: `Project ${n}`,
  slug: `project-${n}`,
  ...over,
});
const member = (n: number, over: Partial<ProjectMember> = {}): ProjectMember => ({
  ...testProjectMember,
  userId: userId(n),
  email: `member${n}@example.com`,
  displayName: `Member ${n}`,
  role: 'project_member',
  ...over,
});

const projectNotFoundError = {
  code: 'project_not_found',
  message: 'Project was not found',
  correlationId: 'srv-9',
};
const forbiddenError = {
  code: 'forbidden',
  message: 'server text that must never be shown',
  correlationId: 'srv-8',
};
const internalError = {
  code: 'internal_error',
  message: 'server text that must never be shown',
  correlationId: 'srv-7',
};
const ANONYMOUS: SessionValue = { status: 'anonymous' };

interface Fake {
  organizations?: OrganizationWithRole[];
  /** Exactly the projects the caller may see (visibility is the server's job; the UI shows what it is given). */
  projects: Project[];
  members?: Record<string, ProjectMember[]>;
  listProjects?: (url: URL) => Response | Promise<Response>;
  getProject?: (id: string) => Response | Promise<Response>;
  listMembers?: (id: string, url: URL) => Response | Promise<Response>;
}

function api(fake: Fake) {
  const organizations = fake.organizations ?? [organization(1)];
  return mockFetch(({ url, init }) => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    if (path === '/health') return jsonResponse(healthOk);
    if (path === '/auth/logout') return new Response(null, { status: 204 });

    const page = (items: unknown[]) => {
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse({
        items: items.slice(offset, offset + limit),
        page: { limit, offset, total: items.length },
      });
    };

    if (path === '/organizations' && method === 'GET') return page(organizations);
    const org = /^\/organizations\/([^/]+)$/.exec(path);
    if (org) {
      const found = organizations.find((o) => o.id === decodeURIComponent(org[1]!));
      return found ? jsonResponse(found) : jsonResponse(organizationNotFoundError, 404);
    }

    if (path === '/projects' && method === 'GET') {
      if (fake.listProjects) return fake.listProjects(url);
      const status = url.searchParams.get('status');
      return page(
        fake.projects.filter(
          (p) =>
            p.organizationId === url.searchParams.get('organizationId') &&
            (status === 'all' || p.status === status),
        ),
      );
    }
    const members = /^\/projects\/([^/]+)\/members$/.exec(path);
    if (members) {
      const id = decodeURIComponent(members[1]!);
      return fake.listMembers ? fake.listMembers(id, url) : page(fake.members?.[id] ?? []);
    }
    const one = /^\/projects\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      if (fake.getProject) return fake.getProject(id);
      const found = fake.projects.find((p) => p.id === id);
      return found ? jsonResponse(found) : jsonResponse(projectNotFoundError, 404);
    }
    return jsonResponse({ code: 'not_found', message: 'x', correlationId: 'c' }, 404);
  });
}

const requestsTo = (
  spy: ReturnType<typeof mockFetch>,
  test: (path: string, query: URLSearchParams) => boolean,
) =>
  spy.mock.calls.filter(([url]) => {
    const parsed = new URL(String(url), 'http://localhost');
    return test(parsed.pathname.replace(/^\/api\/v1/, ''), parsed.searchParams);
  });
const listRequests = (spy: ReturnType<typeof mockFetch>) => requestsTo(spy, (path) => path === '/projects');
const memberRequests = (spy: ReturnType<typeof mockFetch>) =>
  requestsTo(spy, (path) => path.endsWith('/members'));
const detailRequests = (spy: ReturnType<typeof mockFetch>, id: string) =>
  requestsTo(spy, (path) => path === `/projects/${id}`);

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const settled = () => new Promise<void>((done) => setTimeout(done, 0));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
const many = <T,>(count: number, make: (n: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => make(i + 1));

const LIST = organizationProjectsPath(orgId(1));
// A row's accessible name is its cells joined: the name, then the slug. Anchoring keeps "Project 1" from matching "Project 10".
const rowOf = async (name: string) =>
  within(await screen.findByRole('row', { name: new RegExp(`^${name} `) }));

describe('the project list (ADR-0012 D2, D5)', () => {
  it(
    "shows the projects of the organization in the URL, in the API's order, with their status and the caller's access",
    async () => {
      const spy = api({
        projects: [
          project(1, { projectRole: 'project_admin' }),
          project(2, { status: 'archived', archivedAt: '2026-04-01T00:00:00.000Z' }),
          project(3),
        ],
      });
      renderApp(LIST);

      expect(await heading('Projects')).toBeInTheDocument();
      // The default filter is the real `status=active`: the archived project is not asked for.
      expect(listRequests(spy)).toHaveLength(1);
      expect(String(listRequests(spy)[0]![0])).toContain(`organizationId=${orgId(1)}`);
      expect(String(listRequests(spy)[0]![0])).toContain('status=active');
      expect(String(listRequests(spy)[0]![0])).toContain('limit=20&offset=0');

      const first = await rowOf('Project 1');
      expect(first.getByRole('link', { name: 'Project 1' })).toHaveAttribute(
        'href',
        `${LIST}/${projectId(1)}`,
      );
      expect(first.getByText('project-1')).toBeInTheDocument();
      expect(first.getByText('Active')).toBeInTheDocument();
      expect(first.getByText('Project admin')).toBeInTheDocument(); // an explicit project role
      expect(first.getByText('Mar 2, 2026')).toBeInTheDocument();

      const third = await rowOf('Project 3');
      expect(third.getByText('Through your organization role')).toBeInTheDocument(); // projectRole is null
      expect(screen.queryByText('Project 2')).toBeNull(); // archived: not in the active filter
      const names = screen
        .getAllByRole('link')
        .filter((l) => /^Project \d$/.test(l.textContent ?? ''))
        .map((l) => l.textContent);
      expect(names).toEqual(['Project 1', 'Project 3']); // the API's order, not re-sorted
      expect(screen.getByText('Showing 1 to 2 of 2')).toBeInTheDocument();
    },
    SLOW,
  );

  it('offers no sorting and no search, because the API has neither', async () => {
    api({ projects: [project(1), project(2)] });
    renderApp(LIST);
    await rowOf('Project 1');

    expect(document.querySelector('[aria-sort]')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    for (const header of screen.getAllByRole('columnheader'))
      expect(within(header).queryByRole('button')).toBeNull();
  });

  it(
    'filters by the real status parameter and starts again from the first page',
    async () => {
      const projects = [
        ...many(25, (n) => project(n)),
        // Enough archived rows that page 2 would exist: keeping the page across a filter change would be visible.
        ...many(25, (n) =>
          project(100 + n, {
            name: `Old Idea ${n}`,
            status: 'archived',
            archivedAt: '2026-04-01T00:00:00.000Z',
          }),
        ),
      ];
      const spy = api({ projects });
      renderApp(LIST);
      await rowOf('Project 1');

      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Project pages' })).getByRole('button', {
          name: 'Page 2',
        }),
      );
      expect(await screen.findByText('Showing 21 to 25 of 25')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('radio', { name: 'Archived' }));
      expect(await screen.findByText('Showing 1 to 20 of 25')).toBeInTheDocument();
      const archived = await rowOf('Old Idea 1');
      expect(archived.getByText('Archived')).toBeInTheDocument();
      const archivedRequests = listRequests(spy).filter(([url]) => String(url).includes('status=archived'));
      // Never page 2 of the other filter.
      expect(archivedRequests.map(([url]) => String(url).match(/offset=(\d+)/)![1])).toEqual(['0']);

      fireEvent.click(screen.getByRole('radio', { name: 'All' }));
      await screen.findByText('Showing 1 to 20 of 50');
      expect(String(listRequests(spy).at(-1)![0])).toContain('status=all');
    },
    SLOWER,
  );

  it(
    "pages with the real limit and offset and shows the server's total",
    async () => {
      const spy = api({ projects: many(45, (n) => project(n)) });
      renderApp(LIST);

      expect(await screen.findByText('Showing 1 to 20 of 45')).toBeInTheDocument();
      const pages = within(screen.getByRole('navigation', { name: 'Project pages' }));
      fireEvent.click(pages.getByRole('button', { name: 'Page 2' }));
      expect(await screen.findByText('Showing 21 to 40 of 45')).toBeInTheDocument();
      expect(String(listRequests(spy).at(-1)![0])).toContain('limit=20&offset=20');
      expect(screen.getByRole('link', { name: 'Project 21' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Project 20' })).toBeNull();

      // The controls are rendered again with each page: look them up again.
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Project pages' })).getByRole('button', {
          name: 'Page 3',
        }),
      );
      expect(await screen.findByText('Showing 41 to 45 of 45')).toBeInTheDocument();
      expect(String(listRequests(spy).at(-1)![0])).toContain('offset=40');
    },
    SLOW,
  );

  it(
    'moves back to the last page when rows disappear while a later page is open',
    async () => {
      const fake: Fake = { projects: many(21, (n) => project(n)) };
      api(fake);
      const { queryClient } = renderApp(LIST);
      await rowOf('Project 1');
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Project pages' })).getByRole('button', {
          name: 'Page 2',
        }),
      );
      await screen.findByText('Showing 21 to 21 of 21');

      fake.projects = fake.projects.slice(0, 20); // page 2 no longer exists
      await act(() => queryClient.invalidateQueries({ queryKey: ['projects'] }));

      expect(await screen.findByText('Showing 1 to 20 of 20')).toBeInTheDocument();
      expect(screen.queryByText(/There are no/)).toBeNull(); // not an empty state: the list is not empty
    },
    SLOW,
  );

  it('has no paging controls when everything fits on one page', async () => {
    api({ projects: [project(1)] });
    renderApp(LIST);
    await rowOf('Project 1');

    expect(
      within(screen.getByRole('navigation', { name: 'Project pages' })).queryByRole('button', {
        name: 'Page 2',
      }),
    ).toBeNull();
  });

  it('says what is empty for each filter', async () => {
    api({ projects: [] });
    renderApp(LIST);

    expect(await screen.findByText('There are no active projects that you can open.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }));
    expect(await screen.findByText('There are no archived projects that you can open.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(await screen.findByText('There are no projects that you can open.')).toBeInTheDocument();
  });

  it('shows a loading state while the list is requested', async () => {
    const answer = deferred<Response>();
    api({ projects: [project(1)], listProjects: () => answer.promise });
    renderApp(LIST);

    expect(await within(await screen.findByRole('main')).findByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('row')).toBeNull();
    answer.resolve(jsonResponse({ items: [project(1)], page: { limit: 20, offset: 0, total: 1 } }));
    await rowOf('Project 1');
  });

  it(
    'shows an error with Try again for a server failure, in translated text, and recovers',
    async () => {
      let failing = true;
      api({
        projects: [project(1)],
        listProjects: () =>
          failing
            ? jsonResponse(internalError, 500)
            : jsonResponse({ items: [project(1)], page: { limit: 20, offset: 0, total: 1 } }),
      });
      renderApp(LIST);

      const retry = await screen.findByRole('button', { name: 'Try again' });
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      expect(screen.getByText(/Reference: srv-7/)).toBeInTheDocument();
      failing = false;
      fireEvent.click(retry);
      await rowOf('Project 1');
    },
    SLOW,
  );

  it("shows a permission-denied state for a 403, with a way back, and never the server's text", async () => {
    api({ projects: [], listProjects: () => jsonResponse(forbiddenError, 403) });
    renderApp(LIST);

    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute('href', LIST);
  });

  it(
    "starts from the first page of another organization and never shows the previous organization's rows",
    async () => {
      const spy = api({
        organizations: [organization(1), organization(2)],
        projects: [
          ...many(25, (n) => project(n)),
          // Organization 2 also has a second page, so keeping the page across the switch would be visible.
          ...many(25, (n) => project(200 + n, { organizationId: orgId(2), name: `Other Org Project ${n}` })),
        ],
      });
      const { router } = renderApp(organizationProjectsPath(orgId(2)));
      await rowOf('Other Org Project 1');
      // Organization 2 is now cached: coming back to it does not pass through a loading state that would reset the page by itself,
      // so only the list's own reset can start it from the first page.
      await act(() => router.navigate(LIST));
      await rowOf('Project 1');
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Project pages' })).getByRole('button', {
          name: 'Page 2',
        }),
      );
      await screen.findByText('Showing 21 to 25 of 25');

      await act(() => router.navigate(organizationProjectsPath(orgId(2))));

      await rowOf('Other Org Project 1');
      expect(screen.getByText('Showing 1 to 20 of 25')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Project 21' })).toBeNull();
      const ofOrganization2 = listRequests(spy).filter(([url]) =>
        String(url).includes(`organizationId=${orgId(2)}`),
      );
      expect(ofOrganization2.map(([url]) => String(url).match(/offset=(\d+)/)![1])).toEqual(['0']);
    },
    SLOWEST,
  );

  it('shows what each caller is given: a project role is shown as such, organization access as such', async () => {
    api({
      projects: [
        project(1, { projectRole: 'project_viewer' }),
        project(2, { projectRole: 'project_member' }),
        project(3, { projectRole: null }),
      ],
    });
    renderApp(LIST);

    expect((await rowOf('Project 1')).getByText('Project viewer')).toBeInTheDocument();
    expect((await rowOf('Project 2')).getByText('Project member')).toBeInTheDocument();
    expect((await rowOf('Project 3')).getByText('Through your organization role')).toBeInTheDocument();
  });

  it(
    'renders in Persian, right to left, with the same content',
    async () => {
      api({ projects: [project(1)] });
      renderApp(LIST, { preferences: { locale: 'fa' } });

      expect(await heading('پروژه‌ها')).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute('dir', 'rtl');
      expect(screen.getByRole('radio', { name: 'بایگانی‌شده' })).toBeInTheDocument();
      expect(await screen.findByRole('link', { name: 'Project 1' })).toBeInTheDocument();
      expect(within(screen.getByRole('row', { name: /^Project 1 / })).getByText('فعال')).toBeInTheDocument();
    },
    SLOW,
  );
});

describe("a project's details", () => {
  const DETAILS = (n: number, org = 1) => `${organizationProjectsPath(orgId(org))}/${projectId(n)}`;

  it(
    'opens from the list and shows its fields, with the Overview tab current',
    async () => {
      api({ projects: [project(1, { projectRole: 'project_admin', description: 'Move the platform.' })] });
      const { router } = renderApp(LIST);

      fireEvent.click(await screen.findByRole('link', { name: 'Project 1' }));

      expect(await heading('Project 1')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe(DETAILS(1));
      const nav = screen.getByRole('navigation', { name: 'Project sections' });
      expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: 'Members' })).not.toHaveAttribute('aria-current');
      const fields = within(screen.getByRole('table'));
      expect(fields.getByText('project-1')).toBeInTheDocument();
      expect(fields.getByText('Move the platform.')).toBeInTheDocument();
      expect(screen.getByText('Project admin')).toBeInTheDocument();
      expect(screen.getByText('Mar 2, 2026')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull(); // not archived
    },
    SLOW,
  );

  it('says so when there is no description, and uses the organization access wording when there is no project role', async () => {
    api({ projects: [project(1, { description: null, projectRole: null })] });
    renderApp(DETAILS(1));

    await heading('Project 1');
    expect(screen.getByText('No description')).toBeInTheDocument();
    expect(screen.getByText('Through your organization role')).toBeInTheDocument();
  });

  it('marks an archived project as read-only and shows when it was archived', async () => {
    api({ projects: [project(1, { status: 'archived', archivedAt: '2026-04-01T08:00:00.000Z' })] });
    renderApp(DETAILS(1));

    await heading('Project 1');
    expect(screen.getByText('This project is archived. It is read-only.')).toBeInTheDocument();
    expect(screen.getByText('Archived', { selector: '.ant-tag' })).toBeInTheDocument();
    expect(screen.getByText('Apr 1, 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit|restore|archive/i })).toBeNull();
  });

  it('has the static document title "Project", never the project\'s name', async () => {
    api({ projects: [project(1, { name: 'Confidential Codename' })] });
    renderApp(DETAILS(1));

    await heading('Confidential Codename');
    expect(document.title).toBe('Project · AgentOS');
    expect(document.title).not.toContain('Confidential');
  });

  it('is the same not-found as project_not_found for a project that does not exist, with a way back', async () => {
    const spy = api({ projects: [] });
    renderApp(DETAILS(404));

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.getByText('It may not exist, or you may not have access to it.')).toBeInTheDocument();
    expect(detailRequests(spy, projectId(404))).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'Back to projects' }));
    expect(await heading('Projects')).toBeInTheDocument();
  });

  it('is the SAME not-found, with no field of the project, when the project belongs to another organization than the path says', async () => {
    api({
      organizations: [organization(1), organization(2)],
      projects: [
        project(5, {
          organizationId: orgId(2),
          name: 'Secret Roadmap',
          description: 'Eyes only',
          slug: 'secret-roadmap',
        }),
      ],
    });
    renderApp(DETAILS(5, 1)); // organization 1 in the path, organization 2's project

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.getByText('It may not exist, or you may not have access to it.')).toBeInTheDocument();
    for (const leaked of ['Secret Roadmap', 'Eyes only', 'secret-roadmap'])
      expect(screen.queryByText(leaked), leaked).toBeNull();
    expect(document.title).not.toContain('Secret');
    expect(screen.queryByText(/elsewhere|another organization/i)).toBeNull();
  });

  it('shows the project under the organization it belongs to', async () => {
    api({
      organizations: [organization(1), organization(2)],
      projects: [project(5, { organizationId: orgId(2), name: 'Right Place' })],
    });
    renderApp(DETAILS(5, 2));

    expect(await heading('Right Place')).toBeInTheDocument();
  });

  it('treats something that is not an id as the same not-found, without a request', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(`${LIST}/not-an-id`);

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(requestsTo(spy, (path) => path === '/projects/not-an-id')).toHaveLength(0);
  });

  it(
    'shows an error with Try again for a server failure and recovers',
    async () => {
      let failing = true;
      api({
        projects: [project(1)],
        getProject: () => (failing ? jsonResponse(internalError, 500) : jsonResponse(project(1))),
      });
      renderApp(DETAILS(1));

      const retry = await screen.findByRole('button', { name: 'Try again' });
      expect(screen.queryByText('Project not found')).toBeNull(); // an error is not a not-found
      failing = false;
      fireEvent.click(retry);
      expect(await heading('Project 1')).toBeInTheDocument();
    },
    SLOW,
  );

  it('shows a loading state while the project is requested', async () => {
    const answer = deferred<Response>();
    api({ projects: [project(1)], getProject: () => answer.promise });
    renderApp(DETAILS(1));

    expect(await within(await screen.findByRole('main')).findByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('heading', { level: 1, name: 'Project 1' })).toBeNull();
    answer.resolve(jsonResponse(project(1)));
    await heading('Project 1');
  });

  it(
    'renders in Persian',
    async () => {
      api({ projects: [project(1, { projectRole: 'project_member' })] });
      renderApp(DETAILS(1), { preferences: { locale: 'fa' } });

      await heading('Project 1');
      expect(
        within(screen.getByRole('navigation', { name: 'بخش‌های پروژه' })).getByRole('link', {
          name: 'نمای کلی',
        }),
      ).toHaveAttribute('aria-current', 'page');
      expect(screen.getByText('عضو پروژه')).toBeInTheDocument();
    },
    SLOW,
  );
});

describe("a project's members (paginated, explicit members only)", () => {
  const MEMBERS = `${LIST}/${projectId(1)}/members`;

  it(
    'is the second tab, and lists the explicit members with their role, email and join date',
    async () => {
      const spy = api({
        projects: [project(1)],
        members: { [projectId(1)]: [member(1, { role: 'project_admin' }), member(2)] },
      });
      renderApp(`${LIST}/${projectId(1)}`);
      await heading('Project 1');

      fireEvent.click(screen.getByRole('link', { name: 'Members' }));

      expect(await screen.findByRole('row', { name: /Member 1/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
      expect(document.title).toBe('Members · AgentOS');
      const first = within(screen.getByRole('row', { name: /Member 1/ }));
      expect(first.getByText('member1@example.com')).toBeInTheDocument();
      expect(first.getByText('Project admin')).toBeInTheDocument();
      expect(first.getByText('Mar 2, 2026')).toBeInTheDocument();
      expect(
        within(screen.getByRole('row', { name: /Member 2/ })).getByText('Project member'),
      ).toBeInTheDocument();
      expect(memberRequests(spy)).toHaveLength(1);
      expect(String(memberRequests(spy)[0]![0])).toContain(
        `/projects/${projectId(1)}/members?limit=20&offset=0`,
      );
      expect(screen.getByText('Showing 1 to 2 of 2')).toBeInTheDocument();
    },
    SLOW,
  );

  it('says that organization owners and admins appear only if they also hold a project role', async () => {
    api({ projects: [project(1)], members: { [projectId(1)]: [member(1)] } });
    renderApp(MEMBERS);

    await screen.findByRole('row', { name: /Member 1/ });
    expect(screen.getByText(/Organization owners and admins can open every project/)).toBeInTheDocument();
  });

  it('marks the signed-in user as "You" and nobody else', async () => {
    api({
      projects: [project(1)],
      members: { [projectId(1)]: [member(1), { ...testProjectMember, role: 'project_admin' }] },
    });
    renderApp(MEMBERS);

    const mine = within(await screen.findByRole('row', { name: new RegExp(testUser.displayName) }));
    expect(mine.getByText('You')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Member 1/ })).queryByText('You')).toBeNull();
  });

  it(
    'pages with the real limit and offset, and shows the real total',
    async () => {
      const spy = api({
        projects: [project(1)],
        members: { [projectId(1)]: many(45, (n) => member(n)) },
      });
      renderApp(MEMBERS);

      expect(await screen.findByText('Showing 1 to 20 of 45')).toBeInTheDocument();
      const pages = within(screen.getByRole('navigation', { name: 'Member pages' }));
      fireEvent.click(pages.getByRole('button', { name: 'Page 3' }));
      expect(await screen.findByText('Showing 41 to 45 of 45')).toBeInTheDocument();
      expect(String(memberRequests(spy).at(-1)![0])).toContain('limit=20&offset=40');
      expect(screen.getByRole('row', { name: /Member 41/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Member 40/ })).toBeNull();
    },
    SLOW,
  );

  it(
    "starts from the first page when the user moves to another project's members",
    async () => {
      const spy = api({
        projects: [project(1), project(2)],
        members: {
          [projectId(1)]: many(45, (n) => member(n)),
          [projectId(2)]: many(45, (n) => member(100 + n)),
        },
      });
      const { router } = renderApp(`${LIST}/${projectId(2)}/members`);
      await screen.findByRole('row', { name: /Member 101/ });
      // Project 2 is now cached: moving back to it does not pass through a loading state that would reset the page by itself.
      await act(() => router.navigate(MEMBERS));
      await screen.findByRole('row', { name: /Member 1 / });
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Member pages' })).getByRole('button', {
          name: 'Page 3',
        }),
      );
      await screen.findByText('Showing 41 to 45 of 45');

      await act(() => router.navigate(`${LIST}/${projectId(2)}/members`));

      expect(await screen.findByText('Showing 1 to 20 of 45')).toBeInTheDocument();
      expect(await screen.findByRole('row', { name: /Member 101/ })).toBeInTheDocument();
      const ofProject2 = memberRequests(spy).filter(([url]) =>
        String(url).includes(`/projects/${projectId(2)}/`),
      );
      expect(ofProject2.map(([url]) => String(url).match(/offset=(\d+)/)![1])).toEqual(['0']);
    },
    SLOWEST,
  );

  it('has no sorting, filtering or search, because the endpoint has none', async () => {
    api({ projects: [project(1)], members: { [projectId(1)]: [member(1), member(2)] } });
    renderApp(MEMBERS);
    await screen.findByRole('row', { name: /Member 1/ });

    expect(document.querySelector('[aria-sort]')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('works on an archived project (reading is allowed) and keeps the read-only notice', async () => {
    api({
      projects: [project(1, { status: 'archived', archivedAt: '2026-04-01T00:00:00.000Z' })],
      members: { [projectId(1)]: [member(1)] },
    });
    renderApp(MEMBERS);

    expect(await screen.findByRole('row', { name: /Member 1/ })).toBeInTheDocument();
    expect(screen.getByText('This project is archived. It is read-only.')).toBeInTheDocument();
  });

  it('says so when no one holds an explicit role', async () => {
    api({ projects: [project(1)], members: {} });
    renderApp(MEMBERS);

    expect(await screen.findByText('No one holds an explicit role on this project yet.')).toBeInTheDocument();
  });

  it(
    'shows an error with Try again for a server failure and recovers',
    async () => {
      let failing = true;
      api({
        projects: [project(1)],
        listMembers: () =>
          failing
            ? jsonResponse(internalError, 500)
            : jsonResponse({ items: [member(1)], page: { limit: 20, offset: 0, total: 1 } }),
      });
      renderApp(MEMBERS);

      const retry = await screen.findByRole('button', { name: 'Try again' });
      failing = false;
      fireEvent.click(retry);
      expect(await screen.findByRole('row', { name: /Member 1/ })).toBeInTheDocument();
    },
    SLOW,
  );

  it('shows a loading state while the members are requested', async () => {
    const answer = deferred<Response>();
    api({ projects: [project(1)], listMembers: () => answer.promise });
    renderApp(MEMBERS);

    await heading('Project 1');
    expect(await within(await screen.findByRole('main')).findByRole('status')).toHaveTextContent('Loading');
    answer.resolve(jsonResponse({ items: [member(1)], page: { limit: 20, offset: 0, total: 1 } }));
    await screen.findByRole('row', { name: /Member 1/ });
  });

  it('a 403 means "your access changed": a permission-denied state, and the project is refetched', async () => {
    const spy = api({
      projects: [project(1)],
      listMembers: () => jsonResponse(forbiddenError, 403),
    });
    renderApp(MEMBERS);

    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
    await waitFor(() => expect(detailRequests(spy, projectId(1)).length).toBeGreaterThanOrEqual(2));
  });

  it('a 404 for the members re-evaluates the project: if it is gone too, the whole page becomes the not-found state', async () => {
    let gone = false;
    api({
      projects: [project(1)],
      getProject: () => (gone ? jsonResponse(projectNotFoundError, 404) : jsonResponse(project(1))),
      listMembers: () => {
        gone = true; // access was removed between the two requests
        return jsonResponse(projectNotFoundError, 404);
      },
    });
    renderApp(MEMBERS);

    await waitFor(() => {
      expect(screen.getByText('Project not found')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Project 1' })).toBeNull();
      expect(screen.queryByRole('navigation', { name: 'Project sections' })).toBeNull(); // the layout itself is gone
    });
  });

  it('is not shown for a project that belongs to another organization than the path says', async () => {
    const spy = api({
      organizations: [organization(1), organization(2)],
      projects: [project(5, { organizationId: orgId(2) })],
      members: { [projectId(5)]: [member(1)] },
    });
    renderApp(`${LIST}/${projectId(5)}/members`);

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Member 1/ })).toBeNull();
    expect(memberRequests(spy)).toHaveLength(0); // the members tab never mounted
  });

  it(
    'renders in Persian',
    async () => {
      api({ projects: [project(1)], members: { [projectId(1)]: [member(1)] } });
      renderApp(MEMBERS, { preferences: { locale: 'fa' } });

      expect(await screen.findByRole('row', { name: /Member 1/ })).toBeInTheDocument();
      expect(screen.getByText('عضو پروژه')).toBeInTheDocument();
      expect(screen.getByText(/مالکان و مدیران سازمان/)).toBeInTheDocument();
    },
    SLOW,
  );
});

describe('the projects UI and the session (ADR-0012 D4)', () => {
  it('makes no project or organization request while the session is anonymous, and sends the visitor to sign in', async () => {
    const spy = api({ projects: [project(1)] });
    renderApp(`${LIST}/${projectId(1)}/members`, { session: ANONYMOUS });

    expect(await heading('Sign in')).toBeInTheDocument();
    await act(settled);
    expect(
      requestsTo(spy, (path) => path.startsWith('/projects') || path.startsWith('/organizations')),
    ).toHaveLength(0);
  });

  it(
    'removes every cached project entry when the user signs out',
    async () => {
      api({ projects: [project(1)], members: { [projectId(1)]: [member(1)] } });
      const { queryClient } = renderApp(`${LIST}/${projectId(1)}/members`);
      await screen.findByRole('row', { name: /Member 1/ });
      expect(queryClient.getQueryCache().findAll({ queryKey: ['projects'] }).length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

      expect(await heading('Sign in')).toBeInTheDocument();
      expect(queryClient.getQueryCache().findAll({ queryKey: ['projects'] })).toHaveLength(0);
    },
    SLOW,
  );

  it('a 401 on a project request ends the session: the user is sent to sign in', async () => {
    api({
      projects: [],
      listProjects: () =>
        jsonResponse(
          { code: 'unauthenticated', message: 'Authentication is required', correlationId: 'srv-0a' },
          401,
        ),
    });
    renderApp(LIST);

    expect(await heading('Sign in')).toBeInTheDocument();
  });
});
