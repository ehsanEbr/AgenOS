import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import {
  healthOk,
  invalidCredentialsError,
  jsonResponse,
  loginOk,
  meOk,
  mockFetch,
  notFoundError,
  organizationPage,
  testOrganization,
  testUser,
  unauthenticatedError,
  validationError,
} from '../../test/fixtures/api';
import { renderApp, renderWithProviders } from '../../test/render';
import { RequireAuth } from './RequireAuth';
import { ANONYMOUS_SESSION, UNRESOLVED_SIGN_OUT } from './session';
import { requireSessionLifecycle } from './session-lifecycle';
import { useCurrentUser, useSignIn } from './use-session';

/*
 * The authentication UI through the real application: the route guard, the public pages, the user menu and the sign-out screens.
 * `fetch` is the only thing faked; routing, providers, translations, the query client and its session lifecycle are the real ones.
 */

type Handler = (init: RequestInit) => Response | Promise<Response>;
interface Routes {
  me?: Handler;
  login?: Handler;
  register?: Handler;
  logout?: Handler;
  /** `GET /organizations` and `POST /organizations`. Default: the caller belongs to one organization. */
  organizations?: Handler;
}

/** The identity API as the browser sees it, plus the health endpoint the shell polls. Anything else is a 404. */
function api(routes: Routes) {
  return mockFetch(({ url, init }) => {
    const path = url.pathname;
    if (path.endsWith('/health')) return jsonResponse(healthOk);
    if (path.endsWith('/organizations'))
      return (routes.organizations ?? (() => jsonResponse(organizationPage([testOrganization]))))(init);
    const handler = path.endsWith('/auth/login')
      ? routes.login
      : path.endsWith('/auth/register')
        ? routes.register
        : path.endsWith('/auth/logout')
          ? routes.logout
          : path.endsWith('/me')
            ? routes.me
            : undefined;
    return handler ? handler(init) : jsonResponse(notFoundError, 404);
  });
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const noContent = () => new Response(null, { status: 204 });
const unauthenticated = () => jsonResponse(unauthenticatedError, 401);
const down = (): Response => {
  throw new TypeError('Failed to fetch');
};
const apiError = (status: number, code: string) => () =>
  jsonResponse({ code, message: 'server text that must never be shown', correlationId: 'srv-1' }, status);

const requestsTo = (spy: ReturnType<typeof mockFetch>, suffix: string) =>
  spy.mock.calls.filter(([url]) => String(url).endsWith(suffix));

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
const submit = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('RequireAuth: the session guard', () => {
  it('sends an anonymous visitor to the sign-in page and remembers where they were going', async () => {
    api({});
    const { router } = renderApp('/some/place?tab=2#top', { session: ANONYMOUS_SESSION });

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.state).toMatchObject({
      from: { pathname: '/some/place', search: '?tab=2', hash: '#top' },
    });
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull(); // no application shell, nothing private
  });

  it('shows a loading state, never the shell and never a redirect, while the first probe is in flight', async () => {
    const answer = deferred<Response>();
    api({ me: () => answer.promise });
    const { router } = renderApp('/', { session: null });

    expect(await screen.findByText('Checking your session')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(router.state.location.pathname).toBe('/');

    answer.resolve(jsonResponse(meOk));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('a probe answering 401 leads to the sign-in page', async () => {
    api({ me: unauthenticated });
    const { router } = renderApp('/', { session: null });

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('a failed probe shows an error with Retry, no private UI and no redirect; Retry recovers', async () => {
    let attempt = 0;
    const spy = api({
      me: () => {
        attempt += 1;
        return attempt <= 3 ? down() : jsonResponse(meOk); // the client's own retry policy uses the first three
      },
    });
    const { router } = renderApp('/', { session: null });

    expect(await screen.findByText('Could not check your session')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(router.state.location.pathname).toBe('/');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(requestsTo(spy, '/me').length).toBe(4);
  });

  it('shows the application for an authenticated session without asking the server again', async () => {
    const spy = api({});
    renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(requestsTo(spy, '/me')).toHaveLength(0);
  });

  it('a session that ends while the user is in the app sends them to sign in, with a notice and the page they were on', async () => {
    api({});
    const { router, queryClient } = renderApp('/missing-page');
    await screen.findByText('Page not found');

    act(() => requireSessionLifecycle(queryClient).transition(ANONYMOUS_SESSION));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
    expect(router.state.location.state).toMatchObject({ from: { pathname: '/missing-page' }, ended: true });
  });

  it('unresolved sign-out: the private UI is gone, the screen says so, and nothing is presented as signed out', async () => {
    const spy = api({});
    const { router } = renderApp('/', { session: UNRESOLVED_SIGN_OUT });

    expect(await screen.findByText('Sign-out is not complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry sign-out' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Sign in' })).toBeNull(); // not presented as signed out
    expect(router.state.location.pathname).toBe('/'); // no redirect
    expect(requestsTo(spy, '/me')).toHaveLength(0); // and no probe
  });

  it('Retry sign-out sends one request; a definite answer ends the session without the "session ended" notice', async () => {
    const spy = api({ logout: noContent });
    renderApp('/', { session: UNRESOLVED_SIGN_OUT });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry sign-out' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(requestsTo(spy, '/auth/logout')).toHaveLength(1);
    expect(screen.queryByText('Your session ended. Sign in again.')).toBeNull();
  });

  it('Retry sign-out that fails again keeps the screen and offers Retry again', async () => {
    api({ logout: down });
    renderApp('/', { session: UNRESOLVED_SIGN_OUT });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry sign-out' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry sign-out' })).toBeEnabled());
    expect(screen.getByText('Sign-out is not complete')).toBeInTheDocument();
  });

  it('from the unresolved screen the user can go to sign in, and signing in supersedes the unresolved sign-out', async () => {
    api({ login: () => jsonResponse(loginOk) });
    const { router } = renderApp('/', { session: UNRESOLVED_SIGN_OUT });

    fireEvent.click(await screen.findByRole('link', { name: 'Go to sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    fill('Email', testUser.email);
    fill('Password', 'a long password here');
    submit('Sign in');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('gives a different user a fresh subtree (no component state of the previous user survives) and refreshes the same user in place', async () => {
    api({});
    let instances = 0;
    function PrivatePage() {
      const [instance] = useState(() => (instances += 1));
      const user = useCurrentUser();
      return <p>{`instance ${instance} for ${user?.displayName}`}</p>;
    }
    const router = createMemoryRouter([
      { element: <RequireAuth />, children: [{ path: '/', element: <PrivatePage /> }] },
    ]);
    const { queryClient } = renderWithProviders(<RouterProvider router={router} />);
    const session = requireSessionLifecycle(queryClient);
    expect(await screen.findByText('instance 1 for Ada Lovelace')).toBeInTheDocument();

    act(() =>
      session.transition({
        status: 'authenticated',
        user: { id: testUser.id, email: testUser.email, displayName: 'Ada L.' },
      }),
    );
    expect(await screen.findByText('instance 1 for Ada L.')).toBeInTheDocument(); // same user: refreshed in place

    act(() =>
      session.transition({
        status: 'authenticated',
        user: { id: 'someone-else', email: 'b@example.com', displayName: 'Grace' },
      }),
    );
    expect(await screen.findByText('instance 2 for Grace')).toBeInTheDocument(); // another user: a new subtree
    expect(screen.queryByText(/for Ada/)).toBeNull();
  });
});

describe('the sign-in page', () => {
  const open = (state?: unknown) => {
    const result = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    if (state) void result.router.navigate('/sign-in', { replace: true, state });
    return result;
  };

  it('is a labelled form with one heading, the right autocomplete hints and a link to sign-up', async () => {
    api({});
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/sign-up');
    expect(document.title).toBe('Sign in · AgentOS');
  });

  it('checks the fields before sending anything, with translated messages', async () => {
    const spy = api({});
    open();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    submit('Sign in');
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();

    fill('Email', 'not-an-email');
    fill('Password', 'secret');
    submit('Sign in');
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(requestsTo(spy, '/auth/login')).toHaveLength(0);
  });

  it('signs in: sends the credentials, publishes the session and lands in the application with the user menu', async () => {
    const spy = api({ login: () => jsonResponse(loginOk) });
    const { router } = open();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', 'a long password here');
    submit('Sign in');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveTextContent('Ada Lovelace');
    const [, init] = requestsTo(spy, '/auth/login')[0]!;
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({
      email: testUser.email,
      password: 'a long password here',
    });
  });

  it('returns the user to the page they were going to', async () => {
    api({ login: () => jsonResponse(loginOk) });
    const { router } = renderApp('/missing-page?x=1#y', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', 'a long password here');
    submit('Sign in');

    await screen.findByText('Page not found');
    expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe(
      '/missing-page?x=1#y',
    );
  });

  it('ignores a "return to" hint that is not an in-app path', async () => {
    api({ login: () => jsonResponse(loginOk) });
    const { router } = open({ from: { pathname: '//evil.example/steal', search: '', hash: '' } });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', 'a long password here');
    submit('Sign in');

    await screen.findByRole('heading', { level: 1, name: 'Choose an organization' });
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('shows the account-created notice and fills in the email after sign-up', async () => {
    api({});
    open({ registered: true, email: 'new@example.com' });

    expect(await screen.findByText('Your account was created. Sign in to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com');
  });

  it.each([
    ['wrong credentials', () => jsonResponse(invalidCredentialsError, 401), 'Incorrect email or password.'],
    [
      'rate limiting',
      apiError(429, 'too_many_attempts'),
      'Too many attempts. Wait a few minutes and try again.',
    ],
    [
      'an unavailable rate limiter',
      apiError(503, 'authentication_unavailable'),
      'Sign-in is temporarily unavailable. Try again shortly.',
    ],
    [
      'a web address the server does not allow',
      apiError(403, 'origin_not_allowed'),
      'This web address is not allowed to sign in. Open the app from the address your administrator configured and try again.',
    ],
    ['a network failure', down, 'Cannot reach the server. Check your connection and try again.'],
    ['a server error', apiError(500, 'internal_error'), 'The server hit an unexpected problem.'],
  ])(
    '%s: shows one translated message, never the server text, and stays signed out',
    async (_name, answer, message) => {
      api({ login: answer });
      open();
      await screen.findByRole('heading', { level: 1, name: 'Sign in' });

      fill('Email', testUser.email);
      fill('Password', 'a long password here');
      submit('Sign in');

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
      expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    },
  );

  it('puts a server-side validation failure on the field it names', async () => {
    api({
      login: () =>
        jsonResponse(
          { ...validationError, details: [{ path: 'email', message: 'Invalid email address' }] },
          400,
        ),
    });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', 'a long password here');
    submit('Sign in');

    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument();
    expect(screen.queryByText('Invalid email address')).toBeNull();
  });

  it('sends ONE request when the form is submitted again while the first is in flight', async () => {
    const answer = deferred<Response>();
    const spy = api({ login: () => answer.promise });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    fill('Email', testUser.email);
    fill('Password', 'a long password here');

    submit('Sign in');
    await waitFor(() => expect(requestsTo(spy, '/auth/login')).toHaveLength(1));
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    answer.resolve(jsonResponse(loginOk));

    await screen.findByRole('heading', { level: 1, name: 'Choose an organization' });
    expect(requestsTo(spy, '/auth/login')).toHaveLength(1);
  });

  it('sends someone who is already signed in on to the application instead of showing the form', async () => {
    api({});
    const { router } = renderApp('/sign-in');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects');
  });

  it('renders in Persian, right to left, with the same fields', async () => {
    api({});
    renderApp('/sign-in', { session: ANONYMOUS_SESSION, preferences: { locale: 'fa' } });

    expect(await screen.findByRole('heading', { level: 1, name: 'ورود' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('ایمیل')).toBeInTheDocument();
    expect(screen.getByLabelText('گذرواژه')).toBeInTheDocument();
  });
});

describe('the pages do not leave the password in the mutation cache', () => {
  const PASSWORD = 'a long password here';
  const retained = (client: {
    getMutationCache: () => { getAll: () => { state: { variables: unknown } }[] };
  }) =>
    client
      .getMutationCache()
      .getAll()
      .filter((mutation) => JSON.stringify(mutation.state.variables ?? null).includes(PASSWORD));
  const settled = () => new Promise<void>((done) => setTimeout(done, 0));

  it('sign-in: after a success', async () => {
    api({ login: () => jsonResponse(loginOk) });
    const { queryClient } = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', PASSWORD);
    submit('Sign in');
    await screen.findByRole('heading', { level: 1, name: 'Choose an organization' });
    await act(settled);

    expect(retained(queryClient)).toHaveLength(0);
  });

  it('sign-in: after a failure, while the user is still looking at the form', async () => {
    api({ login: () => jsonResponse(invalidCredentialsError, 401) });
    const { queryClient } = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    fill('Email', testUser.email);
    fill('Password', PASSWORD);
    submit('Sign in');
    await screen.findByText('Incorrect email or password.');
    await act(settled);

    expect(retained(queryClient)).toHaveLength(0);
  });

  it('sign-up: after a success and after a failure', async () => {
    let attempt = 0;
    api({
      register: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ code: 'email_taken', message: 'x', correlationId: 'c' }, 409)
          : jsonResponse({ user: testUser }, 201);
      },
    });
    const { queryClient } = renderApp('/sign-up', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });
    fill('Email', 'new@example.com');
    fill('Name', 'New User');
    fill('Password', PASSWORD);

    submit('Create account');
    await screen.findByText('An account with this email already exists.');
    await act(settled);
    expect(retained(queryClient)).toHaveLength(0);

    submit('Create account');
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    await act(settled);
    expect(retained(queryClient)).toHaveLength(0);
  });
});

describe('the sign-up page', () => {
  const open = () => renderApp('/sign-up', { session: ANONYMOUS_SESSION });
  const fillForm = (password = 'a long password here') => {
    fill('Email', 'New.User@Example.com');
    fill('Name', 'New User');
    fill('Password', password);
  };

  it('is a labelled form that states the password rule', async () => {
    api({});
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Create an account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it('applies the contract rules before sending: a short password, a missing name', async () => {
    const spy = api({});
    open();
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });

    fill('Email', 'new@example.com');
    fill('Password', 'too short');
    submit('Create account');

    expect(await screen.findByText('Enter your name.')).toBeInTheDocument();
    expect(screen.getAllByText('Use at least 12 characters.').length).toBeGreaterThan(1); // the hint and the error
    expect(requestsTo(spy, '/auth/register')).toHaveLength(0);
  });

  it('creates the account and continues on the sign-in page: the API does not sign the user in', async () => {
    const spy = api({ register: () => jsonResponse({ user: testUser }, 201) });
    const { router } = open();
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });

    fillForm();
    submit('Create account');

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.getByText('Your account was created. Sign in to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('New.User@Example.com');
    expect(JSON.parse(String(requestsTo(spy, '/auth/register')[0]![1]?.body))).toEqual({
      email: 'New.User@Example.com',
      displayName: 'New User',
      password: 'a long password here',
    });
    expect(requestsTo(spy, '/auth/login')).toHaveLength(0); // no automatic sign-in
  });

  it('says plainly that registration is closed, using the actual 403, instead of leaving a form that cannot work', async () => {
    api({ register: apiError(403, 'registration_closed') });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });

    fillForm();
    submit('Create account');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Registration is closed' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/only be added by an administrator/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it('puts "email already used" on the email field', async () => {
    api({ register: apiError(409, 'email_taken') });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });

    fillForm();
    submit('Create account');

    expect(await screen.findByText('An account with this email already exists.')).toBeInTheDocument();
  });

  it('shows the translated rate-limit message', async () => {
    api({ register: apiError(429, 'too_many_attempts') });
    open();
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });

    fillForm();
    submit('Create account');

    expect(
      await screen.findByText('Too many attempts. Wait a few minutes and try again.'),
    ).toBeInTheDocument();
  });

  it('sends someone who is already signed in on to the application', async () => {
    api({});
    renderApp('/sign-up');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Choose an organization' }),
    ).toBeInTheDocument();
  });
});

describe('leaving a page while its request runs, and coming back', () => {
  const FIRST_PASSWORD = 'the first long password';
  const SECOND_PASSWORD = 'the second long password';
  // A loading Ant Design button is named "loading <label>" (its icon), so the label is matched as a pattern.
  const loading = (label: RegExp) =>
    within(screen.getByRole('button', { name: label })).queryByRole('img', { name: 'loading' }) !== null;
  const pressEnter = () => fireEvent.submit(screen.getByLabelText('Email').closest('form')!); // a submit the disabled-looking button cannot stop
  const settled = () => new Promise<void>((done) => setTimeout(done, 0));

  it('sign-in: the page opened again shows the request as pending and sends nothing; the request of the first page completes', async () => {
    const answer = deferred<Response>();
    const spy = api({ login: () => answer.promise });
    renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    fill('Email', testUser.email);
    fill('Password', FIRST_PASSWORD);
    submit('Sign in');
    await waitFor(() => expect(requestsTo(spy, '/auth/login')).toHaveLength(1));

    fireEvent.click(screen.getByRole('link', { name: 'Create one' })); // the user leaves ...
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' })); // ... and comes back
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });

    await waitFor(() => expect(loading(/Sign in/)).toBe(true)); // the new page knows, without having asked for anything
    fill('Email', 'someone.else@example.com');
    fill('Password', SECOND_PASSWORD);
    pressEnter();
    await act(settled);
    expect(requestsTo(spy, '/auth/login')).toHaveLength(1); // not sent
    expect(screen.queryByRole('alert')).toBeNull(); // and not reported as a failure: the first request is still running

    answer.resolve(jsonResponse(loginOk));
    await screen.findByRole('heading', { level: 1, name: 'Choose an organization' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECOND_PASSWORD);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('someone.else@example.com');
  });

  it('sign-in: a submission that slips past the page (another instance started first) is refused with a translated message, never sent', async () => {
    const answer = deferred<Response>();
    const spy = api({ login: () => answer.promise });
    const { queryClient } = renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    const other = renderHook(() => useSignIn(), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    fill('Email', 'someone.else@example.com');
    fill('Password', SECOND_PASSWORD);

    // Another instance starts in the same tick as the user's click: the page cannot have heard of it yet.
    act(() => {
      void other.result.current
        .mutateAsync({ email: testUser.email, password: FIRST_PASSWORD })
        .catch(() => {});
    });
    submit('Sign in');

    expect(
      await screen.findByText('A request is already in progress. Wait for it to finish, then try again.'),
    ).toBeInTheDocument();
    expect(requestsTo(spy, '/auth/login')).toHaveLength(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECOND_PASSWORD);
    answer.resolve(jsonResponse(invalidCredentialsError, 401));
    await act(settled);
  });

  it('sign-up: a different email entered on the page opened again is never sent and never reported as registered', async () => {
    const answer = deferred<Response>();
    const spy = api({ register: () => answer.promise });
    const { router } = renderApp('/sign-up', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });
    fill('Email', 'first.person@example.com');
    fill('Name', 'First Person');
    fill('Password', FIRST_PASSWORD);
    submit('Create account');
    await waitFor(() => expect(requestsTo(spy, '/auth/register')).toHaveLength(1));

    fireEvent.click(screen.getByRole('link', { name: 'Sign in' })); // leaves the page while the request runs
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    fireEvent.click(screen.getByRole('link', { name: 'Create one' })); // opens sign-up again
    await screen.findByRole('heading', { level: 1, name: 'Create an account' });
    await waitFor(() => expect(loading(/Create account/)).toBe(true));

    fill('Email', 'second.person@example.com');
    fill('Name', 'Second Person');
    fill('Password', SECOND_PASSWORD);
    pressEnter();
    await act(settled);
    expect(requestsTo(spy, '/auth/register')).toHaveLength(1);

    answer.resolve(jsonResponse({ user: testUser }, 201));
    await act(settled);
    await act(settled);

    // Whatever the router did when the first request finished, the second email is nowhere: it was neither sent nor reported.
    expect(JSON.stringify(spy.mock.calls)).not.toContain('second.person@example.com');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECOND_PASSWORD);
    expect(screen.queryByDisplayValue('second.person@example.com')).toBeInTheDocument(); // still what the user typed, untouched
    expect(screen.queryByText('Your account was created. Sign in to continue.')).toBeNull();
    expect(router.state.location.pathname).toBe('/sign-up'); // the user's current route is not overridden by the page that was left
  });
});

describe('the user menu and sign-out in the shell', () => {
  async function openMenu() {
    const button = await screen.findByRole('button', { name: 'Account menu' });
    fireEvent.click(button);
    return screen.findByRole('menuitem', { name: /Sign out/ });
  }

  it('shows who is signed in and offers sign-out', async () => {
    api({});
    renderApp('/');

    await openMenu();
    expect(screen.getByText(`Signed in as ${testUser.email}`)).toBeInTheDocument();
  });

  it('signs out: one request, then the sign-in page without a "session ended" notice', async () => {
    const spy = api({ logout: noContent });
    const { router } = renderApp('/');

    fireEvent.click(await openMenu());

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(requestsTo(spy, '/auth/logout')).toHaveLength(1);
    expect(screen.queryByText('Your session ended. Sign in again.')).toBeNull();
  });

  it('after a lost response the logout is repeated once, and a definite answer then signs the user out', async () => {
    let attempt = 0;
    const spy = api({
      logout: () => {
        attempt += 1;
        return attempt === 1 ? down() : noContent();
      },
    });
    renderApp('/');

    fireEvent.click(await openMenu());

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(requestsTo(spy, '/auth/logout')).toHaveLength(2);
    expect(requestsTo(spy, '/me')).toHaveLength(0);
  });

  it('when the repeat fails too, the private UI stays gone and the user is offered Retry, never told they are signed out', async () => {
    const spy = api({ logout: down });
    renderApp('/');

    fireEvent.click(await openMenu());

    const screenTitle = await screen.findByText('Sign-out is not complete');
    expect(screenTitle).toBeInTheDocument();
    expect(within(document.body).queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
    expect(requestsTo(spy, '/auth/logout')).toHaveLength(2);
    expect(requestsTo(spy, '/me')).toHaveLength(0);
  });

  it('a double click on Sign out sends one request', async () => {
    const answer = deferred<Response>();
    const spy = api({ logout: () => answer.promise });
    renderApp('/');

    const item = await openMenu();
    fireEvent.click(item);
    fireEvent.click(item);
    answer.resolve(noContent());

    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(requestsTo(spy, '/auth/logout')).toHaveLength(1);
  });

  it('is not shown on the public pages', async () => {
    api({});
    renderApp('/sign-in', { session: ANONYMOUS_SESSION });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });
});

describe('a 401 from the API while the user works', () => {
  it('the session probe on a stale refetch ending in 401 returns the user to sign-in', async () => {
    api({ me: unauthenticated });
    const { queryClient, router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });
});

vi.setConfig({ testTimeout: 15_000 });
