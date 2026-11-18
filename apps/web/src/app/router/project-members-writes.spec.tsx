import type {
  Member,
  OrganizationRole,
  OrganizationWithRole,
  Project,
  ProjectMember,
  ProjectRole,
} from '@agentos/contracts';
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
  unauthenticatedError,
} from '../../test/fixtures/api';
import { renderApp } from '../../test/render';
import { organizationProjectsPath } from './paths';

/*
 * Project member management through the real application (ADR-0012 D3, D5; step 6): add (with the organization-member picker), change a
 * role, remove, and the self-removal warning. `fetch` is the only thing faked. The fake API follows the real service
 * (apps/api .../project-member.service.ts): adding needs the target to be a member of the project's organization (`404
 * organization_member_not_found`) and not a member already (`409 already_project_member`); changing or removing a non-member is `404
 * project_member_not_found`; EVERY change on an archived project is `409 project_archived`; and, like the real service, it has NO "last
 * project admin" rule (ADR-0011): removing or demoting the only project admin is accepted.
 */

/*
 * Timeouts. Every test here renders the whole application (shell, router, tables, dialogs) in jsdom, which is slow, and a hosted CI runner
 * is much slower than a development machine: the first hosted run timed out tests that take a few seconds here at a limit of 20 s. A test
 * that was MEASURED at 2 s or more gets one of these tiers, chosen so that the timeout is at least 4 times the slowest time seen for the
 * tier in any local run, including a run with the process restricted to one CPU: a healthy test does not fail on a slow runner, and a test
 * that hangs still fails within a minute and a half. Untiered tests use the 30 s default of vite.config.ts. (No test in this file was
 * measured over 12 s, so the tier above these two, used by the project-list spec, is not defined here.)
 *   SLOW     measured 2 to 7 s   (13 s seen with one CPU)
 *   SLOWER   measured 7 to 12 s
 */
const SLOW = 60_000;
const SLOWER = 90_000;

const pad = (n: number) => String(n).padStart(12, '0');
const orgId = (n: number) => `00000000-0000-4000-8000-${pad(n)}`;
const projectId = (n: number) => `10000000-0000-4000-8000-${pad(n)}`;
const userId = (n: number) => `20000000-0000-4000-8000-${pad(n)}`;

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
const projectMember = (n: number, role: ProjectRole = 'project_member'): ProjectMember => ({
  ...testProjectMember,
  userId: userId(n),
  email: `member${n}@example.com`,
  displayName: `Member ${n}`,
  role,
});
/** The signed-in test user as a project member. */
const me = (role: ProjectRole = 'project_admin'): ProjectMember => ({ ...testProjectMember, role });
const orgMember = (n: number, role: OrganizationRole = 'member'): Member => ({
  userId: userId(n),
  email: `member${n}@example.com`,
  displayName: `Member ${n}`,
  role,
  joinedAt: '2026-02-01T10:00:00.000Z',
});
const orgMe = (role: OrganizationRole = 'owner'): Member => ({
  userId: testUser.id,
  email: testUser.email,
  displayName: testUser.displayName,
  role,
  joinedAt: '2026-01-05T09:30:00.000Z',
});

const err = (status: number, code: string) => () =>
  jsonResponse({ code, message: 'server text that must never be shown', correlationId: 'srv-m1' }, status);
const forbidden = err(403, 'forbidden');
const archivedError = err(409, 'project_archived');
const alreadyMember = err(409, 'already_project_member');
const orgMemberNotFound = err(404, 'organization_member_not_found');
const memberNotFound = err(404, 'project_member_not_found');
const internal = err(500, 'internal_error');
const validation = () =>
  jsonResponse(
    {
      code: 'validation_error',
      message: 'server text',
      details: [{ path: 'userId', message: 'x' }],
      correlationId: 's',
    },
    400,
  );

type Reply = Response | Promise<Response>;
interface Fake {
  organizations?: OrganizationWithRole[];
  projects: Project[];
  /** The organization's members, as `GET /organizations/:id/members` answers. */
  orgMembers?: Member[];
  /** The explicit members of each project. */
  members?: Record<string, ProjectMember[]>;
  /** Each override returns a reply, or `undefined` to fall through to the fake service's own rules. */
  onAdd?: (projectId: string, body: Record<string, unknown>) => Reply | undefined;
  onChange?: (projectId: string, userId: string, body: Record<string, unknown>) => Reply | undefined;
  onRemove?: (projectId: string, userId: string) => Reply | undefined;
  listOrgMembers?: (url: URL) => Reply | undefined;
  listMembers?: (projectId: string, url: URL) => Reply | undefined;
  organizationDetail?: (id: string) => Reply | undefined;
}

function api(fake: Fake) {
  const orgs = () => fake.organizations ?? [organization(1)];
  const rows = (id: string) => (fake.members ??= {})[id] ?? ((fake.members![id] = []) as ProjectMember[]);
  return mockFetch(({ url, init }) => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
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

    const orgMembers = /^\/organizations\/([^/]+)\/members$/.exec(path);
    if (orgMembers && method === 'GET')
      return fake.listOrgMembers?.(url) ?? page(fake.orgMembers ?? [orgMe()]);
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

    const memberOne = /^\/projects\/([^/]+)\/members\/([^/]+)$/.exec(path);
    const memberAll = /^\/projects\/([^/]+)\/members$/.exec(path);
    if (memberAll && method === 'GET') {
      const id = decodeURIComponent(memberAll[1]!);
      return fake.listMembers?.(id, url) ?? page(rows(id));
    }
    if (memberAll && method === 'POST') {
      const id = decodeURIComponent(memberAll[1]!);
      const request = body();
      const override = fake.onAdd?.(id, request);
      if (override) return override;
      const owner = fake.projects.find((p) => p.id === id);
      if (!owner) return err(404, 'project_not_found')();
      if (owner.status === 'archived') return archivedError();
      const target = (fake.orgMembers ?? [orgMe()]).find((m) => m.userId === request.userId);
      if (!target) return orgMemberNotFound();
      if (rows(id).some((m) => m.userId === request.userId)) return alreadyMember();
      const added: ProjectMember = {
        userId: target.userId,
        email: target.email,
        displayName: target.displayName,
        role: request.projectRole as ProjectRole,
        joinedAt: '2026-05-01T10:00:00.000Z',
      };
      rows(id).push(added);
      if (added.userId === testUser.id) owner.projectRole = added.role;
      return jsonResponse(added, 201);
    }
    if (memberOne && method === 'PATCH') {
      const id = decodeURIComponent(memberOne[1]!);
      const uid = decodeURIComponent(memberOne[2]!);
      const request = body();
      const override = fake.onChange?.(id, uid, request);
      if (override) return override;
      const owner = fake.projects.find((p) => p.id === id);
      if (!owner) return err(404, 'project_not_found')();
      if (owner.status === 'archived') return archivedError();
      const current = rows(id).find((m) => m.userId === uid);
      if (!current) return memberNotFound();
      current.role = request.projectRole as ProjectRole; // no "last project admin" rule, as in the real service
      if (uid === testUser.id) owner.projectRole = current.role;
      return jsonResponse(current);
    }
    if (memberOne && method === 'DELETE') {
      const id = decodeURIComponent(memberOne[1]!);
      const uid = decodeURIComponent(memberOne[2]!);
      const override = fake.onRemove?.(id, uid);
      if (override) return override;
      const owner = fake.projects.find((p) => p.id === id);
      if (!owner) return err(404, 'project_not_found')();
      if (owner.status === 'archived') return archivedError();
      const list = rows(id);
      const at = list.findIndex((m) => m.userId === uid);
      if (at < 0) return memberNotFound();
      list.splice(at, 1);
      if (uid === testUser.id) owner.projectRole = null;
      return new Response(null, { status: 204 });
    }

    const one = /^\/projects\/([^/]+)$/.exec(path);
    if (one) {
      const found = fake.projects.find((p) => p.id === decodeURIComponent(one[1]!));
      if (!found) return err(404, 'project_not_found')();
      // Like the real service: a project is visible to owners and admins, and to anyone with a project role; to nobody else.
      const role = orgs().find((o) => o.id === found.organizationId)?.role;
      const visible = role === 'owner' || role === 'admin' || found.projectRole !== null;
      return visible ? jsonResponse(found) : err(404, 'project_not_found')();
    }
    return jsonResponse({ code: 'not_found', message: 'x', correlationId: 'c' }, 404);
  });
}

type Spy = ReturnType<typeof mockFetch>;
const calls = (spy: Spy, method: string, test: (path: string) => boolean) =>
  spy.mock.calls.filter(([url, init]) => {
    const path = new URL(String(url), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    return ((init as RequestInit | undefined)?.method ?? 'GET') === method && test(path);
  });
const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
const adds = (spy: Spy, id = projectId(1)) => calls(spy, 'POST', (p) => p === `/projects/${id}/members`);
const changes = (spy: Spy, id = projectId(1)) =>
  calls(spy, 'PATCH', (p) => p.startsWith(`/projects/${id}/members/`));
const removes = (spy: Spy, id = projectId(1)) =>
  calls(spy, 'DELETE', (p) => p.startsWith(`/projects/${id}/members/`));
const memberLists = (spy: Spy, id = projectId(1)) =>
  calls(spy, 'GET', (p) => p === `/projects/${id}/members`).filter(([url]) =>
    String(url).includes('limit=20'),
  );
const memberIdLists = (spy: Spy, id = projectId(1)) =>
  calls(spy, 'GET', (p) => p === `/projects/${id}/members`).filter(([url]) =>
    String(url).includes('limit=100'),
  );
const orgMemberLists = (spy: Spy) => calls(spy, 'GET', (p) => /^\/organizations\/[^/]+\/members$/.test(p));
const details = (spy: Spy, id = projectId(1)) => calls(spy, 'GET', (p) => p === `/projects/${id}`);
const orgRoleCalls = (spy: Spy) => calls(spy, 'GET', (p) => p === `/organizations/${orgId(1)}`);
const projectListCalls = (spy: Spy) => calls(spy, 'GET', (p) => p === '/projects');

const LIST = organizationProjectsPath(orgId(1));
const MEMBERS = (n = 1) => `${LIST}/${projectId(n)}/members`;
const settled = () => new Promise<void>((done) => setTimeout(done, 0));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
const many = <T,>(count: number, make: (n: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => make(i + 1));

const rowOf = async (name: string) =>
  within(await screen.findByRole('row', { name: new RegExp(`^${name} `) }));
const dialog = async (title: string) => {
  const found = await screen.findByRole('dialog');
  await within(found).findAllByText(title);
  return within(found);
};
const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const mainButton = async (name: string | RegExp) =>
  within(await screen.findByRole('main')).queryByRole('button', { name });
/** The organization role is read twice (the organization route, then this feature's own query): wait until both were answered. */
const rolesKnown = async (spy: Spy) => {
  await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThanOrEqual(2));
  await act(settled);
};

/**
 * While a request runs a dialog must not be dismissable through the screen: Cancel is disabled and the close button is gone. (Escape and
 * the mask are covered where they can be: `features/projects/member-dialogs.spec.tsx` checks the props each dialog gives `Modal`, because
 * Ant Design's Escape handling cannot be exercised under jsdom. None of the dialogs is a `<form>`, so there is no Enter-key submission
 * path to test: a second activation can only come from the button, which the same-tick tests cover.)
 */
const expectNotDismissable = async (scope: ReturnType<typeof within>) => {
  expect(scope.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(scope.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
};

const openAdd = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
  return dialog('Add a member');
};
const pick = async (picker: ReturnType<typeof within>, name: string) =>
  fireEvent.click(await picker.findByRole('radio', { name: new RegExp(`^${name} \\(`) }));
const confirmAdd = (picker: ReturnType<typeof within>) =>
  fireEvent.click(picker.getByRole('button', { name: /Add member/ }));

// ---------------------------------------------------------------------------------------------------------------------------------

describe('which member controls are shown (the permission helper, ADR-0012 D3)', () => {
  // An organization member or viewer WITHOUT a project role cannot see the project at all (404), so that is not a state of this page.
  const MATRIX: [OrganizationRole, ProjectRole | null, boolean][] = [
    ['owner', null, true],
    ['admin', null, true],
    ['member', 'project_admin', true], // a project role adds project-scoped actions
    ['viewer', 'project_admin', true],
    ['owner', 'project_viewer', true],
    ['member', 'project_member', false],
    ['member', 'project_viewer', false],
    ['viewer', 'project_member', false],
  ];

  it.each(MATRIX)(
    'an ACTIVE project: organization %s with project role %s -> Add member and the row actions are offered: %s',
    async (role, projectRole, offered) => {
      const spy = api({
        organizations: [organization(1, role)],
        projects: [project(1, { projectRole })],
        members: { [projectId(1)]: [projectMember(1)] },
      });
      renderApp(MEMBERS());

      await screen.findByRole('row', { name: /^Member 1 / });
      await rolesKnown(spy);
      const add = await mainButton('Add member');
      expect(!!add).toBe(offered);
      if (add) expect(add).toBeEnabled();
      expect(!!(await mainButton('Change role of Member 1'))).toBe(offered);
      expect(!!(await mainButton('Remove Member 1'))).toBe(offered);
      expect(!!screen.queryByRole('columnheader', { name: 'Actions' })).toBe(offered);
    },
    SLOW,
  );

  it.each(MATRIX)(
    'an ARCHIVED project: organization %s with project role %s -> the controls are visible but DISABLED with the reason: %s',
    async (role, projectRole, holders) => {
      const spy = api({
        organizations: [organization(1, role)],
        projects: [archivedProject(1, { projectRole })],
        members: { [projectId(1)]: [projectMember(1)] },
      });
      renderApp(MEMBERS());

      await screen.findByRole('row', { name: /^Member 1 / });
      await rolesKnown(spy);
      const add = await mainButton('Add member');
      expect(!!add).toBe(holders);
      if (add) {
        expect(add).toBeDisabled();
        expect(
          screen.getAllByTitle('The members of an archived project cannot be changed. Restore it first.')
            .length,
        ).toBeGreaterThan(0);
        expect(await mainButton('Change role of Member 1')).toBeDisabled();
        expect(await mainButton('Remove Member 1')).toBeDisabled();
      }
    },
  );

  it('does not open a dialog when a disabled control of an archived project is clicked', async () => {
    const spy = api({ projects: [archivedProject(1)], members: { [projectId(1)]: [projectMember(1)] } });
    renderApp(MEMBERS());
    await screen.findByRole('row', { name: /^Member 1 / });
    await rolesKnown(spy);

    fireEvent.click((await mainButton('Add member'))!);
    fireEvent.click((await mainButton('Remove Member 1'))!);
    await act(settled);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it(
    'offers nothing until the organization role is known (fail closed), and nothing when it cannot be read',
    async () => {
      const pending = deferred<Response>();
      let asked = 0;
      const spy = api({
        projects: [project(1)],
        members: { [projectId(1)]: [projectMember(1)] },
        organizationDetail: () => (++asked === 2 ? pending.promise : undefined),
      });
      renderApp(MEMBERS());

      await screen.findByRole('row', { name: /^Member 1 / });
      await waitFor(() => expect(orgRoleCalls(spy).length).toBe(2));
      await act(settled);
      expect(await mainButton('Add member')).toBeNull();
      expect(await mainButton('Remove Member 1')).toBeNull();
      expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();

      pending.resolve(jsonResponse(organization(1)));
      expect(await screen.findByRole('button', { name: 'Add member' })).toBeEnabled();
    },
    SLOW,
  );

  it('keeps the read experience for someone who cannot manage: the same rows and columns, "You", and no controls', async () => {
    const spy = api({
      organizations: [organization(1, 'member')],
      projects: [project(1, { projectRole: 'project_member' })],
      members: { [projectId(1)]: [me('project_member'), projectMember(1, 'project_admin')] },
    });
    renderApp(MEMBERS());

    const mine = await rowOf(testUser.displayName);
    await rolesKnown(spy);
    expect(mine.getByText('You')).toBeInTheDocument();
    expect(mine.getByText('Project member')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /^Member 1 / })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add member|Change role|Remove/ })).toBeNull();
    expect(screen.getByText('Showing 1 to 2 of 2')).toBeInTheDocument();
  });

  it('lists explicit memberships only: an organization admin without a project role is not a row, and nothing here makes them one', async () => {
    const spy = api({
      organizations: [organization(1, 'admin')],
      projects: [project(1, { projectRole: null })],
      members: { [projectId(1)]: [projectMember(1)] },
    });
    renderApp(MEMBERS());

    await screen.findByRole('row', { name: /^Member 1 / });
    await rolesKnown(spy);
    expect(screen.queryByRole('row', { name: new RegExp(`^${testUser.displayName} `) })).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.getByText(/Organization owners and admins can open every project/)).toBeInTheDocument();
    expect(await mainButton('Add member')).toBeEnabled(); // implicit administrative access can manage the members
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('dialogs and a lost permission', () => {
  const KINDS = ['add', 'change', 'remove'] as const;

  it.each(KINDS)(
    'an open %s dialog goes with the member controls when they are lost, and does not come back when they return',
    async (kind) => {
      const fake: Fake = {
        projects: [project(1)],
        orgMembers: [orgMe('owner'), orgMember(1)],
        members: { [projectId(1)]: [projectMember(1), projectMember(2, 'project_admin')] },
      };
      api(fake);
      const { queryClient } = renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const addInPage = async () =>
        within(await screen.findByRole('main')).getByRole('button', { name: 'Add member' });

      if (kind === 'add') fireEvent.click(await addInPage());
      else if (kind === 'change')
        fireEvent.click(await screen.findByRole('button', { name: 'Change role of Member 1' }));
      else fireEvent.click(await screen.findByRole('button', { name: 'Remove Member 1' }));
      await screen.findByRole('dialog');

      // The project is archived elsewhere and the page refetches it: the controls are no longer enabled, and the dialog goes with them.
      Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-02T00:00:00.000Z' });
      await act(() => queryClient.invalidateQueries({ queryKey: ['projects', 'detail', projectId(1)] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(async () => expect(await addInPage()).toBeDisabled());

      // The project is restored: the controls return, and the dialog must not.
      Object.assign(fake.projects[0]!, { status: 'active', archivedAt: null });
      await act(() => queryClient.invalidateQueries({ queryKey: ['projects', 'detail', projectId(1)] }));
      await waitFor(async () => expect(await addInPage()).toBeEnabled());
      await act(settled);
      expect(screen.queryByRole('dialog')).toBeNull();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('the organization-member picker (ADR-0012 D5)', () => {
  it(
    'lists the organization members with their organization role, 100 per request, and says how many it shows',
    async () => {
      const spy = api({
        projects: [project(1)],
        orgMembers: [orgMe('owner'), orgMember(1, 'member'), orgMember(2, 'admin'), orgMember(3, 'viewer')],
        members: { [projectId(1)]: [] },
      });
      renderApp(MEMBERS());
      const picker = await openAdd();

      expect(
        await picker.findByRole('radio', { name: /^Member 1 \(member1@example.com\)/ }),
      ).toBeInTheDocument();
      expect(picker.getByRole('radio', { name: /^Member 2 \(member2@example.com\)/ })).toBeInTheDocument();
      expect(picker.getByText('Admin')).toBeInTheDocument();
      expect(picker.getByText('Viewer')).toBeInTheDocument();
      expect(picker.getByText('Showing 4 of 4 organization members.')).toBeInTheDocument();
      expect(String(orgMemberLists(spy)[0]![0])).toContain(
        `/organizations/${orgId(1)}/members?limit=100&offset=0`,
      );
      expect(picker.queryByRole('button', { name: 'Load more' })).toBeNull();
    },
    SLOW,
  );

  it(
    'explains that organization owners and admins already reach every project, and still lets one be added',
    async () => {
      api({
        projects: [project(1)],
        orgMembers: [orgMe('owner'), orgMember(1, 'admin')],
        members: { [projectId(1)]: [] },
      });
      renderApp(MEMBERS());
      const picker = await openAdd();

      expect(
        picker.getByText(/Organization owners and admins can already open every project/),
      ).toBeInTheDocument();
      expect(await picker.findByRole('radio', { name: /^Member 1 \(/ })).toBeEnabled();
    },
    SLOW,
  );

  it(
    'searches ONLY the rows already loaded and says so; "Load more" fetches the next page and the search then covers it',
    async () => {
      const people = [...many(100, (n) => orgMember(n)), orgMe('owner')]; // 101 people: the caller is the one on the second page
      const spy = api({ projects: [project(1)], orgMembers: people, members: { [projectId(1)]: [] } });
      renderApp(MEMBERS());
      const picker = await openAdd();

      expect(
        await picker.findByText('Showing 100 of 101 organization members. Load more to search the rest.'),
      ).toBeInTheDocument();
      expect(
        picker.getByText('The search covers only the organization members listed below.'),
      ).toBeInTheDocument();
      fireEvent.change(picker.getByLabelText('Search the members shown'), {
        target: { value: testUser.displayName },
      });
      expect(picker.getByText('No member shown matches.')).toBeInTheDocument(); // the 101st person is not loaded yet: not found, and not claimed

      fireEvent.click(picker.getByRole('button', { name: 'Load more' }));
      expect(
        await picker.findByRole('radio', { name: new RegExp(`^${testUser.displayName} \\(`) }),
      ).toBeInTheDocument();
      expect(picker.getByText('Showing 101 of 101 organization members.')).toBeInTheDocument();
      expect(String(orgMemberLists(spy).at(-1)![0])).toContain('limit=100&offset=100');
      expect(picker.queryByRole('button', { name: 'Load more' })).toBeNull();

      fireEvent.change(picker.getByLabelText('Search the members shown'), { target: { value: 'member7@' } });
      expect(picker.getAllByRole('radio', { name: /^Member 7\d? \(/ }).length).toBeGreaterThan(0);
      expect(picker.queryByRole('radio', { name: /^Member 1 \(/ })).toBeNull();
    },
    SLOW,
  );

  it(
    "shows people who are members of the project already as disabled, once ALL the project's members are known",
    async () => {
      const all = many(101, (n) => projectMember(n)); // two pages at 100 per request
      const second = deferred<Response>();
      const spy = api({
        projects: [project(1)],
        orgMembers: [orgMe('owner'), orgMember(1), orgMember(101), orgMember(500)],
        members: { [projectId(1)]: all },
        listMembers: (_, url) =>
          url.searchParams.get('limit') === '100' && url.searchParams.get('offset') === '100'
            ? second.promise
            : undefined,
      });
      renderApp(MEMBERS());
      const picker = await openAdd();

      // The first page has arrived, the second has not: nobody is marked yet.
      expect(await picker.findByRole('radio', { name: /^Member 1 \(/ })).toBeEnabled();
      await waitFor(() => expect(memberIdLists(spy)).toHaveLength(2));
      expect(picker.getByRole('radio', { name: /^Member 101 \(/ })).toBeEnabled();

      second.resolve(jsonResponse({ items: all.slice(100), page: { limit: 100, offset: 100, total: 101 } }));
      await waitFor(() => expect(picker.getByRole('radio', { name: /^Member 101 \(/ })).toBeDisabled());
      expect(picker.getByRole('radio', { name: /^Member 1 \(/ })).toBeDisabled();
      expect(picker.getByRole('radio', { name: /^Member 500 \(/ })).toBeEnabled(); // not a member of the project
      expect(picker.getAllByText('Already a member')).toHaveLength(2);
    },
    SLOWER,
  );

  it(
    'says so when the organization has no members, when the list cannot be loaded (with Try again), and while it loads',
    async () => {
      let failing = true;
      const held = deferred<Response>();
      let firstOrganizationMembers = true;
      api({
        projects: [project(1)],
        members: { [projectId(1)]: [] },
        listOrgMembers: () => {
          if (firstOrganizationMembers) {
            firstOrganizationMembers = false;
            return held.promise;
          }
          return failing
            ? internal()
            : jsonResponse({ items: [], page: { limit: 100, offset: 0, total: 0 } });
        },
      });
      renderApp(MEMBERS());
      const picker = await openAdd();

      expect(await picker.findByRole('status')).toHaveTextContent('Loading'); // while it loads
      held.resolve(internal());
      fireEvent.click(await picker.findByRole('button', { name: 'Try again' }));
      expect(await picker.findByText('Could not load the organization members.')).toBeInTheDocument();
      failing = false;
      fireEvent.click(picker.getByRole('button', { name: 'Try again' }));
      expect(await picker.findByText('This organization has no members.')).toBeInTheDocument();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('adding a member', () => {
  const setup = (over: Partial<Fake> = {}) => {
    const fake: Fake = {
      projects: [project(1)],
      orgMembers: [orgMe('owner'), orgMember(1), orgMember(2, 'admin')],
      members: { [projectId(1)]: [projectMember(9, 'project_admin')] },
      ...over,
    };
    return { fake, spy: api(fake) };
  };

  it(
    'adds the chosen person with the chosen role (default: project member); the list and the picker data are refetched',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      const before = memberLists(spy).length;

      // The default role is checked before anyone is chosen. (Checked here, not after choosing: under jsdom Ant Design gives every radio
      // the same name, so choosing a member would uncheck this radio natively. A browser names each group apart.)
      expect(picker.getByRole('radio', { name: 'Project member' })).toBeChecked();
      await pick(picker, 'Member 1');
      confirmAdd(picker);

      expect(await screen.findByText('Member added')).toBeInTheDocument();
      expect(adds(spy)).toHaveLength(1);
      expect(bodyOf(adds(spy)[0]!)).toEqual({ userId: userId(1), projectRole: 'project_member' });
      expect(await screen.findByRole('row', { name: /^Member 1 / })).toBeInTheDocument();
      expect(memberLists(spy).length).toBeGreaterThan(before);
      expect(fake.members![projectId(1)]).toHaveLength(2);
      await closed();
    },
    SLOW,
  );

  it(
    'adds with another role, and an organization admin gets an EXPLICIT row like anyone else',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();

      await pick(picker, 'Member 2');
      fireEvent.click(picker.getByRole('radio', { name: 'Project viewer' }));
      confirmAdd(picker);

      const row = await rowOf('Member 2');
      expect(row.getByText('Project viewer')).toBeInTheDocument();
      expect(bodyOf(adds(spy)[0]!)).toEqual({ userId: userId(2), projectRole: 'project_viewer' });
    },
    SLOWER,
  );

  it(
    'asks to choose a member first, and sends nothing without one',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      const picker = await openAdd();
      await picker.findByRole('radio', { name: /^Member 1 \(/ });

      confirmAdd(picker);
      expect(await picker.findByText('Choose a member.')).toBeInTheDocument();
      expect(adds(spy)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "adding oneself also refreshes the project and the lists (the caller's own project role changes)",
    async () => {
      const { spy } = setup({ projects: [project(1, { projectRole: null })] });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      const detailsBefore = details(spy).length;

      await pick(picker, testUser.displayName);
      confirmAdd(picker);

      await screen.findByText('Member added');
      await waitFor(() => expect(details(spy).length).toBeGreaterThan(detailsBefore));
      expect(await rowOf(testUser.displayName)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'adding someone else leaves the project and the project lists alone (only the member lists are refetched)',
    async () => {
      const { spy } = setup();
      const { router } = renderApp(LIST);
      await screen.findByRole('row', { name: /^Project 1 / });
      await act(() => router.navigate(MEMBERS()));
      await screen.findByRole('row', { name: /^Member 9 / });
      const detailsBefore = details(spy).length;
      const listsBefore = projectListCalls(spy).length;
      const picker = await openAdd();

      await pick(picker, 'Member 1');
      confirmAdd(picker);
      await screen.findByText('Member added');
      await act(settled);

      expect(details(spy)).toHaveLength(detailsBefore);
      expect(projectListCalls(spy)).toHaveLength(listsBefore);
    },
    SLOW,
  );

  it(
    'a person added by someone else meanwhile (409): the picker says so, the members are refetched, and the person is now disabled',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      const idsBefore = memberIdLists(spy).length;

      fake.members![projectId(1)]!.push(projectMember(1)); // someone else added them first
      confirmAdd(picker);

      expect(await picker.findByText('This person is already a member of the project.')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await waitFor(() => expect(memberIdLists(spy).length).toBeGreaterThan(idsBefore));
      await waitFor(() => expect(picker.getByRole('radio', { name: /^Member 1 \(/ })).toBeDisabled());

      // The choice was forgotten: the same request cannot be sent again, and the person can choose someone else.
      expect(picker.getByRole('radio', { name: /^Member 1 \(/ })).not.toBeChecked();
      confirmAdd(picker);
      expect(await picker.findByText('Choose a member.')).toBeInTheDocument();
      await act(settled);
      expect(adds(spy)).toHaveLength(1); // still only the one that failed

      await pick(picker, 'Member 2');
      confirmAdd(picker);
      await screen.findByText('Member added');
      expect(adds(spy)).toHaveLength(2);
      expect(bodyOf(adds(spy)[1]!)).toMatchObject({ userId: userId(2) });
    },
    SLOWER,
  );

  it(
    'a person who left the organization meanwhile (404): the picker says so, drops the choice, and refetches the organization members',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      const before = orgMemberLists(spy).length;

      fake.orgMembers = [orgMe('owner'), orgMember(2, 'admin')];
      confirmAdd(picker);

      expect(
        await picker.findByText('This person is no longer a member of the organization.'),
      ).toBeInTheDocument();
      await waitFor(() => expect(orgMemberLists(spy).length).toBeGreaterThan(before));
      await waitFor(() => expect(picker.queryByRole('radio', { name: /^Member 1 \(/ })).toBeNull());
    },
    SLOW,
  );

  it(
    'a project archived meanwhile (409): the dialog closes and the page is refetched and shown read-only',
    async () => {
      const { fake } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      await pick(picker, 'Member 1');

      Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-02T00:00:00.000Z' });
      confirmAdd(picker);

      expect(await screen.findByText('This project is archived')).toBeInTheDocument(); // the notification title
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await closed();
      expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Add member' })).toBeDisabled();
    },
    SLOW,
  );

  it(
    'a 403 means "your access changed": the dialog closes, the role is refetched, and the controls the person lost disappear',
    async () => {
      const { fake, spy } = setup({ organizations: [organization(1, 'admin')], onAdd: () => forbidden() });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      const roles = orgRoleCalls(spy).length;

      fake.organizations = [organization(1, 'viewer')];
      confirmAdd(picker);

      expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await closed();
      await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThan(roles));
      await waitFor(async () => expect(await mainButton('Add member')).toBeNull());
    },
    SLOW,
  );

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 500', () => internal()],
  ])(
    '%s is UNCERTAIN: the form stays with a notice, the members are refetched, and a retry cannot add the person twice',
    async (_, failure) => {
      let first = true;
      const { fake, spy } = setup({
        onAdd: (id, request) => {
          if (!first) return undefined;
          first = false;
          // The server DID add the person, and the answer was lost.
          fake.members![id]!.push({ ...projectMember(1), role: request.projectRole as ProjectRole });
          return failure();
        },
      });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 9 / });
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      const before = memberLists(spy).length;

      confirmAdd(picker);

      expect(await picker.findByText(/We could not confirm whether the change was made/)).toBeInTheDocument();
      expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await waitFor(() => expect(memberLists(spy).length).toBeGreaterThan(before)); // the table shows the truth
      expect(await screen.findByRole('row', { name: /^Member 1 / })).toBeInTheDocument();

      confirmAdd(picker); // the person tries again
      expect(await picker.findByText('This person is already a member of the project.')).toBeInTheDocument();
      expect(fake.members![projectId(1)]!.filter((m) => m.userId === userId(1))).toHaveLength(1); // never two
    },
    SLOWER,
  );

  it(
    'a server-side validation failure is shown in translated text',
    async () => {
      setup({ onAdd: () => validation() });
      renderApp(MEMBERS());
      const picker = await openAdd();
      await pick(picker, 'Member 1');

      confirmAdd(picker);
      expect(await picker.findByText('This value is not valid.')).toBeInTheDocument();
      expect(screen.queryByText(/server text/)).toBeNull();
    },
    SLOW,
  );

  it(
    'sends ONE request when the confirmation is activated several times in the same tick',
    async () => {
      const answer = deferred<Response>();
      const { fake, spy } = setup({ onAdd: () => answer.promise });
      renderApp(MEMBERS());
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      const ok = picker.getByRole('button', { name: /Add member/ });

      act(() => {
        fireEvent.click(ok);
        fireEvent.click(ok);
        fireEvent.click(ok);
      });
      await waitFor(() => expect(adds(spy)).toHaveLength(1));
      await act(settled);
      expect(adds(spy)).toHaveLength(1);
      answer.resolve(jsonResponse({ ...projectMember(1) }, 201));
      fake.members![projectId(1)]!.push(projectMember(1));
      await screen.findByText('Member added');
      expect(adds(spy)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'cannot be dismissed while the request runs (Cancel, the close button and Escape), and sends nothing more',
    async () => {
      const answer = deferred<Response>();
      const { spy } = setup({ onAdd: () => answer.promise });
      renderApp(MEMBERS());
      const picker = await openAdd();
      await pick(picker, 'Member 1');

      confirmAdd(picker);
      await waitFor(() => expect(adds(spy)).toHaveLength(1));
      await expectNotDismissable(picker);
      expect(adds(spy)).toHaveLength(1);
      answer.resolve(jsonResponse(projectMember(1), 201));
      await screen.findByText('Member added');
    },
    SLOW,
  );

  it(
    'a 401 ends the session: the user is sent to sign in',
    async () => {
      setup({ onAdd: () => jsonResponse(unauthenticatedError, 401) });
      renderApp(MEMBERS());
      const picker = await openAdd();
      await pick(picker, 'Member 1');
      confirmAdd(picker);

      expect(await heading('Sign in')).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'Cancel closes the dialog without a request, and reopening starts clean',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      let picker = await openAdd();
      await pick(picker, 'Member 1');
      fireEvent.change(picker.getByLabelText('Search the members shown'), { target: { value: 'zzz' } });
      fireEvent.click(picker.getByRole('button', { name: 'Cancel' }));
      await closed();

      picker = await openAdd();
      expect(picker.getByLabelText('Search the members shown')).toHaveValue('');
      expect(await picker.findByRole('radio', { name: /^Member 1 \(/ })).not.toBeChecked();
      expect(adds(spy)).toHaveLength(0);
    },
    SLOWER,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe("changing a member's role", () => {
  const open = async (name = 'Member 1') => {
    fireEvent.click(await screen.findByRole('button', { name: `Change role of ${name}` }));
    return dialog(`Change the role of ${name}`);
  };
  const setup = (over: Partial<Fake> = {}) => {
    const fake: Fake = {
      projects: [project(1)],
      members: { [projectId(1)]: [projectMember(1, 'project_member'), projectMember(2, 'project_admin')] },
      ...over,
    };
    return { fake, spy: api(fake) };
  };

  it(
    'shows the current role, sends the new one, and refetches the member list',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      const form = await open();
      const before = memberLists(spy).length;

      expect(form.getByRole('radio', { name: 'Project member' })).toBeChecked();
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await screen.findByText('Role changed')).toBeInTheDocument();
      expect(bodyOf(changes(spy)[0]!)).toEqual({ projectRole: 'project_viewer' });
      expect(changes(spy)[0]![0]).toContain(`/projects/${projectId(1)}/members/${userId(1)}`);
      expect((await rowOf('Member 1')).getByText('Project viewer')).toBeInTheDocument();
      expect(memberLists(spy).length).toBeGreaterThan(before);
      await closed();
    },
    SLOW,
  );

  it(
    'sends the chosen role even when it equals the row on screen: that row may be stale, and the server treats the same role as a no-op',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      const form = await open();
      expect(form.getByRole('radio', { name: 'Project member' })).toBeChecked(); // the snapshot taken when the dialog opened

      fake.members![projectId(1)]![0]!.role = 'project_viewer'; // someone else changed the role since

      fireEvent.click(form.getByRole('button', { name: 'Save role' })); // the person keeps the role they saw: project_member
      await screen.findByText('Role changed');
      expect(changes(spy)).toHaveLength(1);
      expect(bodyOf(changes(spy)[0]!)).toEqual({ projectRole: 'project_member' });
      expect(fake.members![projectId(1)]![0]!.role).toBe('project_member'); // not lost
      await closed();
    },
    SLOW,
  );

  it(
    'does not block demoting the only project admin: the backend has no such rule, so the UI offers it and the server decides',
    async () => {
      const { fake, spy } = setup({ members: { [projectId(1)]: [projectMember(2, 'project_admin')] } });
      renderApp(MEMBERS());
      const form = await open('Member 2');

      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      await screen.findByText('Role changed');
      expect(changes(spy)).toHaveLength(1);
      expect(fake.members![projectId(1)]![0]!.role).toBe('project_viewer'); // accepted by the (fake) service, like the real one
      expect(screen.queryByText(/last/i)).toBeNull();
    },
    SLOW,
  );

  it(
    "changing the caller's own role also refreshes the project and the lists; changing someone else's does not",
    async () => {
      const { spy } = setup({
        projects: [project(1, { projectRole: 'project_admin' })],
        members: { [projectId(1)]: [me('project_admin'), projectMember(1)] },
      });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const detailsBefore = details(spy).length;

      let form = await open('Member 1');
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));
      await screen.findByText('Role changed');
      await closed();
      await act(settled);
      expect(details(spy)).toHaveLength(detailsBefore); // someone else: the project is untouched

      form = await open(testUser.displayName);
      fireEvent.click(form.getByRole('radio', { name: 'Project member' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));
      await waitFor(() => expect(details(spy).length).toBeGreaterThan(detailsBefore));
    },
    SLOWER,
  );

  it(
    'a member removed meanwhile (404): the dialog closes, the list is refetched and the person is told',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      const form = await open();
      const before = memberLists(spy).length;

      fake.members![projectId(1)] = [projectMember(2, 'project_admin')]; // someone else removed Member 1
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await screen.findByText('This member was already removed')).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      await closed();
      await waitFor(() => expect(memberLists(spy).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole('row', { name: /^Member 1 / })).toBeNull());
    },
    SLOW,
  );

  it(
    'a project archived meanwhile (409): the dialog closes and the page is shown read-only',
    async () => {
      const { fake } = setup();
      renderApp(MEMBERS());
      const form = await open();

      Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-02T00:00:00.000Z' });
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await screen.findByText('This project is archived')).toBeInTheDocument();
      await closed();
      expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Change role of Member 1' })).toBeDisabled();
    },
    SLOW,
  );

  it(
    'a 403 means "your access changed": the role is refetched and the controls disappear',
    async () => {
      const { fake, spy } = setup({ organizations: [organization(1, 'admin')], onChange: () => forbidden() });
      renderApp(MEMBERS());
      const form = await open();
      const roles = orgRoleCalls(spy).length;

      fake.organizations = [organization(1, 'viewer')];
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
      await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThan(roles));
      await waitFor(async () => expect(await mainButton('Change role of Member 1')).toBeNull());
    },
    SLOW,
  );

  it(
    'is UNCERTAIN after a network error: the form stays with a notice and the members are refetched',
    async () => {
      const { fake, spy } = setup({
        onChange: (id, uid, request) => {
          fake.members![id]!.find((m) => m.userId === uid)!.role = request.projectRole as ProjectRole; // applied, answer lost
          return Promise.reject(new TypeError('Failed to fetch'));
        },
      });
      renderApp(MEMBERS());
      const form = await open();
      const before = memberLists(spy).length;

      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await form.findByText(/We could not confirm whether the change was made/)).toBeInTheDocument();
      expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
      await waitFor(() => expect(memberLists(spy).length).toBeGreaterThan(before));
      expect((await rowOf('Member 1')).getByText('Project viewer')).toBeInTheDocument(); // the table shows what the server did
    },
    SLOW,
  );

  it(
    'sends ONE request for several activations in the same tick, and cannot be dismissed while it runs',
    async () => {
      const answer = deferred<Response>();
      const { spy } = setup({ onChange: () => answer.promise });
      renderApp(MEMBERS());
      const form = await open();
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      const save = form.getByRole('button', { name: 'Save role' });

      act(() => {
        fireEvent.click(save);
        fireEvent.click(save);
        fireEvent.click(save);
      });
      await waitFor(() => expect(changes(spy)).toHaveLength(1));
      await act(settled);
      expect(changes(spy)).toHaveLength(1);
      await expectNotDismissable(form);
      answer.resolve(jsonResponse({ ...projectMember(1), role: 'project_viewer' }));
      await screen.findByText('Role changed');
    },
    SLOW,
  );

  it(
    'a 401 ends the session: the user is sent to sign in',
    async () => {
      setup({ onChange: () => jsonResponse(unauthenticatedError, 401) });
      renderApp(MEMBERS());
      const form = await open();
      fireEvent.click(form.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(form.getByRole('button', { name: 'Save role' }));

      expect(await heading('Sign in')).toBeInTheDocument();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('removing a member', () => {
  const open = async (name = 'Member 1') => {
    fireEvent.click(await screen.findByRole('button', { name: `Remove ${name}` }));
    return screen.findByRole('dialog').then((d) => within(d));
  };
  const setup = (over: Partial<Fake> = {}) => {
    const fake: Fake = {
      projects: [project(1)],
      members: { [projectId(1)]: [projectMember(1, 'project_member'), projectMember(2, 'project_admin')] },
      ...over,
    };
    return { fake, spy: api(fake) };
  };

  it(
    'asks first (what is lost, and what is not), and Cancel sends nothing',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      const confirm = await open();

      expect(await confirm.findByText('Remove Member 1 from this project?')).toBeInTheDocument();
      expect(confirm.getByText(/They lose their explicit project role/)).toBeInTheDocument();
      expect(
        confirm.getByText(/An ordinary organization member then loses access to this project/),
      ).toBeInTheDocument();
      expect(
        confirm.getByText(/an organization owner or admin keeps access to every project/),
      ).toBeInTheDocument();
      expect(confirm.getByText(/Their organization membership is not affected/)).toBeInTheDocument();
      fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
      await closed();
      expect(removes(spy)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'removes the member once confirmed; the list is refetched and the row is gone',
    async () => {
      const { spy } = setup();
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const confirm = await open();
      const before = memberLists(spy).length;

      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await screen.findByText('Member removed')).toBeInTheDocument();
      expect(removes(spy)).toHaveLength(1);
      expect(removes(spy)[0]![0]).toContain(`/projects/${projectId(1)}/members/${userId(1)}`);
      await waitFor(() => expect(screen.queryByRole('row', { name: /^Member 1 / })).toBeNull());
      expect(memberLists(spy).length).toBeGreaterThan(before);
      expect(screen.getByRole('row', { name: /^Member 2 / })).toBeInTheDocument();
      await closed();
    },
    SLOW,
  );

  it(
    'does not block removing the only project admin: the backend has no such rule, so the UI offers it and the server decides',
    async () => {
      const { fake, spy } = setup({ members: { [projectId(1)]: [projectMember(2, 'project_admin')] } });
      renderApp(MEMBERS());
      const confirm = await open('Member 2');

      expect(confirm.queryByText(/last/i)).toBeNull();
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      await screen.findByText('Member removed');
      expect(removes(spy)).toHaveLength(1);
      expect(fake.members![projectId(1)]).toHaveLength(0); // accepted by the (fake) service, like the real one
      expect(
        await screen.findByText('No one holds an explicit role on this project yet.'),
      ).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'removing oneself while holding access through the organization role (owner/admin): a warning that access is kept; the project stays open',
    async () => {
      const { fake } = setup({
        organizations: [organization(1, 'admin')],
        projects: [project(1, { projectRole: 'project_admin' })],
        members: { [projectId(1)]: [me('project_admin'), projectMember(1)] },
      });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const confirm = await open(testUser.displayName);

      expect(await confirm.findByText('Remove yourself from this project?')).toBeInTheDocument();
      expect(
        confirm.getByText(/you keep access to this project through your organization role/),
      ).toBeInTheDocument();
      expect(
        confirm.getByText(
          'You lose your explicit project role. Your organization membership is not affected.',
        ),
      ).toBeInTheDocument();
      expect(confirm.queryByText(/They lose/)).toBeNull(); // the text is about oneself
      // The reassuring notice is an informational alert, not the stronger warning (read through the accessible icon, not through styling).
      expect(confirm.getByRole('img', { name: 'info-circle' })).toBeInTheDocument();
      expect(confirm.queryByRole('img', { name: 'exclamation-circle' })).toBeNull();
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      await screen.findByText('Member removed');
      await waitFor(() =>
        expect(screen.queryByRole('row', { name: new RegExp(`^${testUser.displayName} `) })).toBeNull(),
      );
      expect(await heading('Project 1')).toBeInTheDocument(); // still there: implicit access
      expect(fake.projects[0]!.projectRole).toBeNull();
    },
    SLOW,
  );

  it(
    'removing oneself WITHOUT organization-level access: the stronger warning; afterwards the project is the not-found state',
    async () => {
      setup({
        organizations: [organization(1, 'member')],
        projects: [project(1, { projectRole: 'project_admin' })],
        members: { [projectId(1)]: [me('project_admin'), projectMember(1)] },
      });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const confirm = await open(testUser.displayName);

      expect(confirm.getByText(/You will lose access to this project/)).toBeInTheDocument();
      // The consequence is the stronger warning (read through the accessible icon, not through styling).
      expect(confirm.getByRole('img', { name: 'exclamation-circle' })).toBeInTheDocument();
      expect(confirm.queryByRole('img', { name: 'info-circle' })).toBeNull();
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await screen.findByText('Project not found')).toBeInTheDocument(); // the project refetch now answers 404
      expect(screen.queryByRole('heading', { level: 1, name: 'Project 1' })).toBeNull();
    },
    SLOW,
  );

  it(
    'a member already removed (404): the dialog closes, the list is refetched and the person is told',
    async () => {
      const { fake, spy } = setup();
      renderApp(MEMBERS());
      const confirm = await open();
      const before = memberLists(spy).length;

      fake.members![projectId(1)] = [projectMember(2, 'project_admin')];
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await screen.findByText('This member was already removed')).toBeInTheDocument();
      await closed();
      await waitFor(() => expect(memberLists(spy).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole('row', { name: /^Member 1 / })).toBeNull());
    },
    SLOW,
  );

  it(
    'a project archived meanwhile (409): the dialog closes and the page is shown read-only',
    async () => {
      const { fake } = setup();
      renderApp(MEMBERS());
      const confirm = await open();

      Object.assign(fake.projects[0]!, { status: 'archived', archivedAt: '2026-05-02T00:00:00.000Z' });
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await screen.findByText('This project is archived')).toBeInTheDocument();
      await closed();
      expect(await screen.findByText('This project is archived. It is read-only.')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Remove Member 1' })).toBeDisabled();
    },
    SLOW,
  );

  it(
    'a 403 means "your access changed": the role is refetched and the controls disappear',
    async () => {
      const { fake, spy } = setup({ organizations: [organization(1, 'admin')], onRemove: () => forbidden() });
      renderApp(MEMBERS());
      const confirm = await open();
      const roles = orgRoleCalls(spy).length;

      fake.organizations = [organization(1, 'viewer')];
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await screen.findByText('Your access has changed')).toBeInTheDocument();
      await waitFor(() => expect(orgRoleCalls(spy).length).toBeGreaterThan(roles));
      await waitFor(async () => expect(await mainButton('Remove Member 1')).toBeNull());
    },
    SLOW,
  );

  it(
    'is UNCERTAIN after a network error: the dialog stays with a notice, and the members are refetched to show what the server did',
    async () => {
      const { fake, spy } = setup({
        onRemove: (id, uid) => {
          fake.members![id] = fake.members![id]!.filter((m) => m.userId !== uid); // applied, answer lost
          return Promise.reject(new TypeError('Failed to fetch'));
        },
      });
      renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      const confirm = await open();
      const before = memberLists(spy).length;

      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(
        await confirm.findByText(/We could not confirm whether the change was made/),
      ).toBeInTheDocument();
      expect(await screen.findByText('The result could not be confirmed')).toBeInTheDocument();
      await waitFor(() => expect(memberLists(spy).length).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole('row', { name: /^Member 1 / })).toBeNull()); // the truth
      expect(screen.queryByText('Member removed')).toBeNull(); // success was not claimed
    },
    SLOW,
  );

  it(
    'sends ONE request for several activations in the same tick, and cannot be dismissed while it runs',
    async () => {
      const answer = deferred<Response>();
      const { spy } = setup({ onRemove: () => answer.promise });
      renderApp(MEMBERS());
      const confirm = await open();
      const ok = confirm.getByRole('button', { name: 'Remove member' });

      act(() => {
        fireEvent.click(ok);
        fireEvent.click(ok);
        fireEvent.click(ok);
      });
      await waitFor(() => expect(removes(spy)).toHaveLength(1));
      await act(settled);
      expect(removes(spy)).toHaveLength(1);
      await expectNotDismissable(confirm);
      answer.resolve(new Response(null, { status: 204 }));
      await screen.findByText('Member removed');
    },
    SLOW,
  );

  it(
    'a 401 ends the session: the user is sent to sign in',
    async () => {
      setup({ onRemove: () => jsonResponse(unauthenticatedError, 401) });
      renderApp(MEMBERS());
      const confirm = await open();
      fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

      expect(await heading('Sign in')).toBeInTheDocument();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('scope and the session', () => {
  it(
    "a change in one project never refetches another project's members",
    async () => {
      const spy = api({
        projects: [project(1), project(2)],
        orgMembers: [orgMe('owner'), orgMember(1)],
        members: {
          [projectId(1)]: [projectMember(9, 'project_admin')],
          [projectId(2)]: [projectMember(8, 'project_admin')],
        },
      });
      const { router } = renderApp(MEMBERS(2));
      await screen.findByRole('row', { name: /^Member 8 / });
      await act(() => router.navigate(MEMBERS(1)));
      await screen.findByRole('row', { name: /^Member 9 / });
      const otherBefore = memberLists(spy, projectId(2)).length;

      const picker = await openAdd();
      await pick(picker, 'Member 1');
      confirmAdd(picker);
      await screen.findByText('Member added');
      await act(settled);

      expect(memberLists(spy, projectId(2))).toHaveLength(otherBefore);
      expect(adds(spy, projectId(2))).toHaveLength(0);
    },
    SLOW,
  );

  it(
    'removes the member dialogs and every cached project entry when the user signs out',
    async () => {
      api({ projects: [project(1)], members: { [projectId(1)]: [projectMember(1)] } });
      const { queryClient } = renderApp(MEMBERS());
      await screen.findByRole('row', { name: /^Member 1 / });
      await act(settled);

      fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

      expect(await heading('Sign in')).toBeInTheDocument();
      expect(queryClient.getQueryCache().findAll({ queryKey: ['projects'] })).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    },
    SLOW,
  );

  it('makes no member request while the session is anonymous', async () => {
    const spy = api({ projects: [project(1)], members: { [projectId(1)]: [projectMember(1)] } });
    renderApp(MEMBERS(), { session: { status: 'anonymous' } });

    await heading('Sign in');
    expect(adds(spy)).toHaveLength(0);
    expect(memberLists(spy)).toHaveLength(0);
    expect(orgMemberLists(spy)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('both languages', () => {
  it(
    'renders the member controls, the picker and the confirmation in Persian, right to left',
    async () => {
      api({
        projects: [project(1)],
        orgMembers: [orgMe('owner'), orgMember(1)],
        members: { [projectId(1)]: [projectMember(1)] },
      });
      renderApp(MEMBERS(), { preferences: { locale: 'fa' } });

      const add = await screen.findByRole('button', { name: 'افزودن عضو' });
      expect(document.documentElement).toHaveAttribute('dir', 'rtl');
      expect(await screen.findByRole('button', { name: 'حذف Member 1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'تغییر نقش Member 1' })).toBeInTheDocument();

      fireEvent.click(add);
      const picker = within(await screen.findByRole('dialog'));
      expect(await picker.findByRole('radiogroup', { name: 'اعضای سازمان' })).toBeInTheDocument();
      expect(picker.getByText('نقش در پروژه')).toBeInTheDocument();
      expect(await picker.findByText(/نمایش 2 از 2 عضو سازمان|نمایش ۲ از ۲ عضو سازمان/)).toBeInTheDocument();
      fireEvent.click(picker.getByRole('button', { name: 'انصراف' }));
      await closed();

      fireEvent.click(screen.getByRole('button', { name: 'حذف Member 1' }));
      const confirm = within(await screen.findByRole('dialog'));
      expect(await confirm.findByText('Member 1 از این پروژه حذف شود؟')).toBeInTheDocument();
      expect(
        confirm.getByText(/عضو معمولی سازمان در نتیجه دسترسی‌اش به این پروژه را از دست می‌دهد/),
      ).toBeInTheDocument();
    },
    SLOW,
  );
});
