import type { OrganizationWithRole } from '@agentos/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  healthOk,
  jsonResponse,
  loginOk,
  mockFetch,
  organizationNotFoundError,
  organizationPage,
  testOrganization,
  unauthenticatedError,
  validationError,
} from '../../test/fixtures/api';
import { renderApp } from '../../test/render';
import type { SessionValue } from '../../features/auth';
import { useUiPreferences } from '../state/ui-preferences.store';
import { organizationProjectsPath } from './paths';

/*
 * The organization pages through the real application (ADR-0012 D2, D5; step 3): the `/projects` redirect, the chooser, the first
 * organization, the organization route and the last-used preference, the shell's switcher, and the end of a session clearing the
 * preference. `fetch` is the only thing faked, and the fake API pages like the real one (`limit`, `offset`, `total`).
 */

// These tests render the whole application (shell, lazy routes, the pages below) and can pass 4 s on a loaded machine: allow for that
// without hiding a real hang.
vi.setConfig({ testTimeout: 20_000 });

const ANONYMOUS_SESSION: SessionValue = { status: 'anonymous' };
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const organization = (n: number, role: OrganizationWithRole['role'] = 'owner'): OrganizationWithRole => ({
  ...testOrganization,
  id: idOf(n),
  name: `Organization ${n}`,
  role,
});

interface Fake {
  organizations: OrganizationWithRole[];
  /** Replaces the answer of `GET /organizations` (a failure, a slow answer). */
  list?: () => Response | Promise<Response>;
  /** Replaces the answer of `GET /organizations/:id`. */
  detail?: (id: string) => Response | Promise<Response>;
  /** Replaces the answer of `POST /organizations`. */
  create?: (body: unknown) => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
  logout?: () => Response | Promise<Response>;
  /** Another request the page may make (for example a private query that answers 401). */
  other?: (path: string) => Response | Promise<Response> | undefined;
}

/** A small fake API: health, the identity calls, and the organizations endpoints with real paging. */
function api(fake: Fake) {
  return mockFetch(({ url, init }) => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    if (path === '/health') return jsonResponse(healthOk);
    if (path === '/projects') return jsonResponse({ items: [], page: { limit: 20, offset: 0, total: 0 } }); // the page below the organization route
    if (path === '/me') return fake.me ? fake.me() : jsonResponse({ user: {}, session: {} }, 500);
    if (path === '/auth/logout') return fake.logout ? fake.logout() : new Response(null, { status: 204 });
    if (path === '/organizations' && method === 'GET') {
      if (fake.list) return fake.list();
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse({
        items: fake.organizations.slice(offset, offset + limit),
        page: { limit, offset, total: fake.organizations.length },
      });
    }
    if (path === '/organizations' && method === 'POST') {
      const body: unknown = JSON.parse(String(init.body));
      if (fake.create) return fake.create(body);
      const created = organization(900 + fake.organizations.length);
      fake.organizations.push({ ...created, name: (body as { name: string }).name });
      return jsonResponse(fake.organizations.at(-1), 201);
    }
    const detail = /^\/organizations\/([^/]+)$/.exec(path);
    if (detail && method === 'GET') {
      const id = decodeURIComponent(detail[1]!);
      if (fake.detail) return fake.detail(id);
      const found = fake.organizations.find((o) => o.id === id);
      return found ? jsonResponse(found) : jsonResponse(organizationNotFoundError, 404);
    }
    return fake.other?.(path) ?? jsonResponse({ code: 'not_found', message: 'x', correlationId: 'c' }, 404);
  });
}

const requestsTo = (spy: ReturnType<typeof mockFetch>, pathAndQuery: string) =>
  spy.mock.calls.filter(([url]) => String(url).replace('/api/v1', '').startsWith(pathAndQuery));
const lastOrganization = () => useUiPreferences.getState().lastOrganizationId;
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const settled = () => new Promise<void>((done) => setTimeout(done, 0));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};

describe('/projects: only a redirect (ADR-0012 D2)', () => {
  it("goes to the last-used organization when it is one of the caller's, replacing itself in the history", async () => {
    api({ organizations: [organization(1), organization(2)] });
    const { router } = renderApp('/projects', { preferences: { lastOrganizationId: idOf(2) } });

    expect(await heading('Projects')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Organization: Organization 2' })).toBeInTheDocument(); // the organization of the URL
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(2)));
    expect(lastOrganization()).toBe(idOf(2));
    await act(() => router.navigate(-1)); // the redirect replaced the entry: back does not return to /projects
    expect(router.state.location.pathname).not.toBe('/projects');
  });

  it("discards a stored id that is not in the list (stale, or another user's) and shows the chooser instead", async () => {
    api({ organizations: [organization(1), organization(2)] });
    const { router } = renderApp('/projects', { preferences: { lastOrganizationId: idOf(77) } });

    expect(await heading('Choose an organization')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
    await waitFor(() => expect(lastOrganization()).toBeNull());
  });

  it('keeps paging while the stored id could still be on a later page, so a long list does not make a valid id look stale', async () => {
    const many = Array.from({ length: 130 }, (_, i) => organization(i + 1));
    const spy = api({ organizations: many });
    const { router } = renderApp('/projects', { preferences: { lastOrganizationId: idOf(125) } });

    expect(await heading('Projects')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(125)));
    expect(requestsTo(spy, '/organizations?limit=100&offset=0')).toHaveLength(1);
    expect(requestsTo(spy, '/organizations?limit=100&offset=100')).toHaveLength(1); // the real offset, not a client-side slice
  });

  it('stops paging when the list is exhausted and discards the id', async () => {
    const many = Array.from({ length: 130 }, (_, i) => organization(i + 1));
    const spy = api({ organizations: many });
    renderApp('/projects', { preferences: { lastOrganizationId: idOf(999) } });

    expect(await heading('Choose an organization')).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations?limit=100')).toHaveLength(2); // two pages, then it stopped
    await waitFor(() => expect(lastOrganization()).toBeNull());
  });

  it('without a stored id it never picks an organization for the user: one organization still shows the chooser', async () => {
    api({ organizations: [organization(1)] });
    const { router } = renderApp('/projects');

    expect(await heading('Choose an organization')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
    expect(lastOrganization()).toBeNull();
  });

  it('a failed list shows an error with Retry, and Retry recovers; nothing is redirected or discarded meanwhile', async () => {
    let failing = true;
    api({
      organizations: [organization(1)],
      list: () =>
        failing
          ? jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500)
          : jsonResponse(organizationPage([organization(1)])),
    });
    renderApp('/projects', { preferences: { lastOrganizationId: idOf(1) } });

    const retry = await screen.findByRole('button', { name: 'Try again' });
    failing = false; // the API recovers, then the user presses Try again
    fireEvent.click(retry);
    expect(await heading('Projects')).toBeInTheDocument();
    expect(lastOrganization()).toBe(idOf(1)); // an error is not evidence that the id is stale
  });
});

describe('the chooser', () => {
  it("lists the caller's organizations with their role, as real links, and says how many it shows", async () => {
    api({ organizations: [organization(1, 'owner'), organization(2, 'viewer')] });
    renderApp('/projects');

    await heading('Choose an organization');
    expect(screen.getByRole('link', { name: 'Organization 1' })).toHaveAttribute(
      'href',
      organizationProjectsPath(idOf(1)),
    );
    expect(screen.getByRole('link', { name: 'Organization 2' })).toHaveAttribute(
      'href',
      organizationProjectsPath(idOf(2)),
    );
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 organizations.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('choosing one opens its page and remembers it', async () => {
    api({ organizations: [organization(1), organization(2)] });
    const { router } = renderApp('/projects');

    fireEvent.click(await screen.findByRole('link', { name: 'Organization 2' }));

    expect(await heading('Projects')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(2)));
    await waitFor(() => expect(lastOrganization()).toBe(idOf(2)));
  });

  it("pages with the API's limit and offset, and never claims the list is complete", async () => {
    const many = Array.from({ length: 150 }, (_, i) => organization(i + 1));
    const spy = api({ organizations: many });
    renderApp('/projects');

    await heading('Choose an organization');
    expect(screen.getByText('Showing 100 of 150 organizations.')).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations?limit=100&offset=0')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Showing 150 of 150 organizations.')).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations?limit=100&offset=100')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('renders in Persian with the same content', async () => {
    api({ organizations: [organization(1)] });
    renderApp('/projects', { preferences: { locale: 'fa' } });

    expect(await heading('یک سازمان را انتخاب کنید')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Organization 1' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });
});

describe('the first organization', () => {
  const open = () => renderApp('/projects');

  it('is offered when the caller has none', async () => {
    api({ organizations: [] });
    open();
    expect(await heading('Create your first organization')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose an organization' })).toBeNull();
  });

  it('checks the name before sending anything', async () => {
    const spy = api({ organizations: [] });
    open();
    await heading('Create your first organization');

    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText('Enter a name for the organization.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText('Use at most 100 characters.')).toBeInTheDocument();
    expect(spy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('creates it, opens its page and remembers it', async () => {
    const fake: Fake = { organizations: [] };
    const spy = api(fake);
    const { router } = open();
    await heading('Create your first organization');

    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: '  Acme Labs  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await heading('Projects')).toBeInTheDocument();
    const created = fake.organizations[0]!;
    expect(router.state.location.pathname).toBe(organizationProjectsPath(created.id));
    expect(JSON.parse(String(spy.mock.calls.find(([, i]) => i?.method === 'POST')![1]!.body))).toEqual({
      name: '  Acme Labs  ',
    });
    await waitFor(() => expect(lastOrganization()).toBe(created.id));
  });

  it('sends ONE request when submitted twice quickly', async () => {
    const answer = deferred<Response>();
    const fake: Fake = { organizations: [], create: () => answer.promise };
    const spy = api(fake);
    open();
    await heading('Create your first organization');
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });

    const form = screen.getByLabelText('Organization name').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(spy.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1));
    fireEvent.submit(form);
    fireEvent.submit(form);
    await act(settled);

    expect(spy.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    fake.organizations.push(organization(5)); // the organization now exists for the route that opens it
    answer.resolve(jsonResponse(organization(5), 201));
    await heading('Projects');
  });

  it("puts a server-side validation failure on the field, in the user's language, and stays on the form", async () => {
    api({ organizations: [], create: () => jsonResponse(validationError, 400) });
    open();
    await heading('Create your first organization');
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument();
    expect(screen.queryByText(/Request validation failed/)).toBeNull(); // the server's own text is never shown
    expect(screen.getByRole('heading', { name: 'Create your first organization' })).toBeInTheDocument();
  });

  it('reports any other failure as a notification and keeps the form', async () => {
    api({
      organizations: [],
      create: () => jsonResponse({ code: 'internal_error', message: 'boom', correlationId: 'srv-1' }, 500),
    });
    open();
    await heading('Create your first organization');
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    expect(await screen.findByText(/Reference: srv-1/)).toBeInTheDocument();
    expect(screen.queryByText('boom')).toBeNull();
    expect(screen.getByLabelText('Organization name')).toHaveValue('Acme');
  });
});

describe('the organization route (the URL is the source of truth)', () => {
  it('opens the organization named in the path and makes it the last-used one: the preference follows the URL', async () => {
    const spy = api({ organizations: [organization(1), organization(2)] });
    renderApp(organizationProjectsPath(idOf(2)), { preferences: { lastOrganizationId: idOf(1) } });

    expect(await heading('Projects')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Organization: Organization 2' })).toBeInTheDocument(); // the organization of the URL
    await waitFor(() => expect(lastOrganization()).toBe(idOf(2)));
    expect(requestsTo(spy, `/organizations/${idOf(1)}`)).toHaveLength(0); // the stored id decided nothing about what was requested
  });

  it('sends the bare organization path to its projects', async () => {
    api({ organizations: [organization(1)] });
    const { router } = renderApp(`/organizations/${idOf(1)}`);

    expect(await heading('Projects')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(1)));
  });

  it('shows one not-found state for an organization the caller cannot open, with a way to the chooser, and forgets a stored id that is this one', async () => {
    const spy = api({ organizations: [organization(1)] });
    const { router } = renderApp(organizationProjectsPath(idOf(404)), {
      preferences: { lastOrganizationId: idOf(404) },
    });

    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(screen.getByText('It may not exist, or you may not have access to it.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Projects' })).toBeNull(); // no page of an organization the caller cannot open
    await waitFor(() => expect(lastOrganization()).toBeNull());
    expect(requestsTo(spy, `/organizations/${idOf(404)}`)).toHaveLength(1);

    fireEvent.click(screen.getByRole('link', { name: 'Choose an organization' }));
    expect(await heading('Choose an organization')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('does not touch the stored id when the missing organization is a different one', async () => {
    api({ organizations: [organization(1)] });
    renderApp(organizationProjectsPath(idOf(404)), { preferences: { lastOrganizationId: idOf(1) } });

    await screen.findByText('Organization not found');
    await act(settled);
    expect(lastOrganization()).toBe(idOf(1));
  });

  it('treats something that is not an id as the same not-found, without a request', async () => {
    const spy = api({ organizations: [organization(1)] });
    renderApp('/organizations/not-an-id/projects');

    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations/not-an-id')).toHaveLength(0);
  });

  it('a row that was removed meanwhile is not offered again: the not-found refetches the lists', async () => {
    const fake: Fake = { organizations: [organization(1), organization(2)] };
    api(fake);
    const { router } = renderApp('/projects');
    await screen.findByRole('link', { name: 'Organization 2' }); // the cached list still offers organization 2
    fake.organizations = [organization(1)]; // the caller was removed from organization 2 in the meantime

    await act(() => router.navigate(organizationProjectsPath(idOf(2))));
    await screen.findByText('Organization not found');
    fireEvent.click(screen.getByRole('link', { name: 'Choose an organization' }));

    await heading('Choose an organization');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Organization 2' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Organization 1' })).toBeInTheDocument();
  });

  it('any other failure is an error with Retry, and nothing is stored', async () => {
    let failing = true;
    api({
      organizations: [organization(1)],
      detail: () =>
        failing
          ? jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500)
          : jsonResponse(organization(1)),
    });
    renderApp(organizationProjectsPath(idOf(1)));

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(lastOrganization()).toBeNull();
    failing = false;
    fireEvent.click(retry);
    expect(await heading('Projects')).toBeInTheDocument();
    await waitFor(() => expect(lastOrganization()).toBe(idOf(1)));
  });

  it("marks Projects as the current section on the organization's project pages", async () => {
    api({ organizations: [organization(1)] });
    renderApp(organizationProjectsPath(idOf(1)));

    await heading('Projects');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});

describe('the organization switcher in the shell', () => {
  const switcher = (name: string) => screen.findByRole('button', { name });

  it('names the organization of the URL, not the stored one, and offers the list only when opened', async () => {
    const spy = api({ organizations: [organization(1), organization(2)] });
    renderApp(organizationProjectsPath(idOf(2)), { preferences: { lastOrganizationId: idOf(1) } });

    const button = await switcher('Organization: Organization 2');
    expect(requestsTo(spy, '/organizations?')).toHaveLength(0); // closed: no list was requested

    fireEvent.click(button);
    const menu = await screen.findByRole('menu', { name: 'Switch organization' });
    expect(await within(menu).findByRole('link', { name: 'Organization 1' })).toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Organization 2' })).toBeInTheDocument();
    expect(within(menu).getByText('Showing 2 of 2')).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations?limit=100&offset=0')).toHaveLength(1);
  });

  it("switching is a navigation to the other organization's project page, and the preference follows the URL", async () => {
    api({ organizations: [organization(1), organization(2)] });
    const { router } = renderApp(organizationProjectsPath(idOf(1)));

    fireEvent.click(await switcher('Organization: Organization 1'));
    fireEvent.click(
      await within(await screen.findByRole('menu', { name: 'Switch organization' })).findByRole('link', {
        name: 'Organization 2',
      }),
    );

    expect(await switcher('Organization: Organization 2')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(2)));
    await waitFor(() => expect(lastOrganization()).toBe(idOf(2)));
  });

  it("does not show the previous organization's name under the new one while the new one loads", async () => {
    const slow = deferred<Response>();
    api({
      organizations: [organization(1), organization(2)],
      detail: (id) => (id === idOf(2) ? slow.promise : jsonResponse(organization(1))),
    });
    renderApp(organizationProjectsPath(idOf(1)));
    fireEvent.click(await switcher('Organization: Organization 1'));
    fireEvent.click(
      await within(await screen.findByRole('menu', { name: 'Switch organization' })).findByRole('link', {
        name: 'Organization 2',
      }),
    );

    await screen.findByRole('button', { name: 'Select an organization' }); // no name yet: not Organization 1
    expect(within(screen.getByRole('main')).queryByText('Organization 1')).toBeNull(); // nor in the page
    slow.resolve(jsonResponse(organization(2)));
    expect(await switcher('Organization: Organization 2')).toBeInTheDocument();
  });

  it('pages the list ("load more") without closing the menu', async () => {
    const many = Array.from({ length: 150 }, (_, i) => organization(i + 1));
    const spy = api({ organizations: many });
    renderApp(organizationProjectsPath(idOf(1)));

    fireEvent.click(await switcher('Organization: Organization 1'));
    const menu = await screen.findByRole('menu', { name: 'Switch organization' });
    expect(await within(menu).findByText('Showing 100 of 150')).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Load more' }));

    expect(await within(menu).findByText('Showing 150 of 150')).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Switch organization' })).toBeInTheDocument();
    expect(requestsTo(spy, '/organizations?limit=100&offset=100')).toHaveLength(1);
  }, 20_000); // 150 menu rows in jsdom

  it('says when the list cannot be loaded and offers to try again', async () => {
    let failing = true;
    api({
      organizations: [organization(1)],
      list: () =>
        failing
          ? jsonResponse({ code: 'internal_error', message: 'x', correlationId: 'c' }, 500)
          : jsonResponse(organizationPage([organization(1)])),
    });
    renderApp(organizationProjectsPath(idOf(1)));

    fireEvent.click(await switcher('Organization: Organization 1'));
    const menu = await screen.findByRole('menu', { name: 'Switch organization' });
    expect(await within(menu).findByText('Could not load organizations')).toBeInTheDocument();
    failing = false;
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Try again' }));
    expect(await within(menu).findByRole('link', { name: 'Organization 1' })).toBeInTheDocument();
  });

  it('is present on every private page and names no organization where the page has none', async () => {
    api({ organizations: [organization(1)] });
    renderApp('/');

    expect(await switcher('Select an organization')).toBeInTheDocument();
  });

  it('is not rendered on the public pages', async () => {
    api({ organizations: [organization(1)] });
    renderApp('/sign-in', { session: ANONYMOUS_SESSION });

    await heading('Sign in');
    expect(screen.queryByRole('button', { name: 'Select an organization' })).toBeNull();
  });
});

describe('the end of a session clears the last-used organization (ADR-0012 D4 rule 5 step 4)', () => {
  const OWN = { preferences: { lastOrganizationId: idOf(1) } };

  it('sign-out clears it, and it stays cleared after the redirect to sign-in', async () => {
    api({ organizations: [organization(1)] });
    renderApp(organizationProjectsPath(idOf(1)), OWN);
    await heading('Projects');
    expect(lastOrganization()).toBe(idOf(1));

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    expect(await heading('Sign in')).toBeInTheDocument();
    expect(lastOrganization()).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem('agentos.ui-preferences')!).state.lastOrganizationId,
    ).toBeNull();
  });

  it('a genuine 401 on a private request clears it', async () => {
    api({
      organizations: [organization(1)],
      list: () => jsonResponse(unauthenticatedError, 401),
    });
    renderApp('/projects', { preferences: { lastOrganizationId: idOf(1) } });

    expect(await heading('Sign in')).toBeInTheDocument();
    expect(lastOrganization()).toBeNull();
  });

  it('a session probe answering 401 at start clears a stored id left by a previous visit', async () => {
    api({ organizations: [organization(1)], me: () => jsonResponse(unauthenticatedError, 401) });
    renderApp('/projects', { session: null, preferences: { lastOrganizationId: idOf(1) } });

    expect(await heading('Sign in')).toBeInTheDocument();
    expect(lastOrganization()).toBeNull();
  });

  it('an uncertain sign-out (unknown, not anonymous) does not clear it; the repeat that ends it does', async () => {
    let attempt = 0;
    api({
      organizations: [organization(1)],
      logout: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError('Failed to fetch');
        return new Response(null, { status: 204 });
      },
    });
    renderApp(organizationProjectsPath(idOf(1)), OWN);
    await heading('Projects');

    // The first attempt is lost (a network error); the automatic repeat answers 204 and ends the session.
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    expect(await heading('Sign in')).toBeInTheDocument();
    expect(attempt).toBe(2);
    expect(lastOrganization()).toBeNull(); // cleared once the repeat answered 204
  });

  it('while the sign-out stays unresolved the stored id is untouched', async () => {
    api({
      organizations: [organization(1)],
      logout: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    renderApp(organizationProjectsPath(idOf(1)), OWN);
    await heading('Projects');

    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    expect(await screen.findByText('Sign-out is not complete')).toBeInTheDocument();
    expect(lastOrganization()).toBe(idOf(1)); // unknown is not an end: nothing is known yet
  });
});

describe('signing in: the default destination is the projects entry (ADR-0012 D4)', () => {
  async function signIn() {
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  }

  const withLogin = (fake: Fake): Fake => ({
    ...fake,
    other: (path) => (path === '/auth/login' ? jsonResponse(loginOk) : undefined),
  });

  it('with no "return to" hint it lands on the projects entry, which opens the stored organization if it is the caller\'s', async () => {
    api(withLogin({ organizations: [organization(1), organization(2)] }));
    const { router } = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    // A stored id the page learns about after it knows it is signed out (for example written by another tab of the same browser).
    useUiPreferences.getState().setLastOrganizationId(idOf(2));
    await signIn();

    expect(await heading('Projects')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(2)));
  });

  it('with no stored id it lands on the chooser', async () => {
    api(withLogin({ organizations: [organization(1)] }));
    const { router } = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await signIn();

    expect(await heading('Choose an organization')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });

  it("a stored id that is not the new user's is never opened: the user sees the chooser", async () => {
    api(withLogin({ organizations: [organization(1)] }));
    renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    useUiPreferences.getState().setLastOrganizationId(idOf(50)); // left by someone else; validated against THIS user's list
    await signIn();

    expect(await heading('Choose an organization')).toBeInTheDocument();
  });

  it('a "return to" hint still wins over the default', async () => {
    api(withLogin({ organizations: [organization(1)] }));
    const { router } = renderApp(organizationProjectsPath(idOf(1)), { session: ANONYMOUS_SESSION });
    await heading('Sign in');
    await signIn();

    expect(await heading('Projects')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(organizationProjectsPath(idOf(1)));
  });
});

describe('private data stays behind the session', () => {
  it('no organization request is made while the session is anonymous', async () => {
    const spy = api({ organizations: [organization(1)] });
    renderApp('/projects', { session: ANONYMOUS_SESSION });

    await heading('Sign in');
    await act(settled);
    expect(requestsTo(spy, '/organizations')).toHaveLength(0);
  });
});
