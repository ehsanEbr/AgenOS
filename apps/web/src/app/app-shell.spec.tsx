import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { healthyApi, jsonResponse, mockFetch, notFoundError } from '../test/fixtures/api';
import { setViewportWidth } from '../test/media';
import { renderApp, renderWithProviders } from '../test/render';
import { AppShell } from './layouts/AppShell';
import { RouteErrorPage } from './router/RouteErrorPage';
import { useUiPreferences } from './state/ui-preferences.store';

const root = document.documentElement;

describe('application shell (desktop)', () => {
  it('renders the overview page inside the persistent layout with proper landmarks', async () => {
    healthyApi();
    renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument(); // <header>
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toBeInTheDocument(); // <aside> sidebar
  });

  it('offers a skip link as the first stop for keyboard users', async () => {
    healthyApi();
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.querySelector('a, button, [tabindex="0"]')).toBe(skip);
  });

  it('shows the product areas: Overview and Projects are links, the rest are disabled placeholders', async () => {
    healthyApi();
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });

    const overview = within(nav).getByRole('link', { name: 'Overview' });
    expect(overview).toHaveAttribute('href', '/');
    expect(overview).toHaveAttribute('aria-current', 'page');

    const projects = within(nav).getByRole('link', { name: 'Projects' });
    expect(projects).toHaveAttribute('href', '/projects'); // the entry point: only a redirect to an organization's projects
    expect(projects).not.toHaveAttribute('aria-current');

    for (const name of [
      'Agents',
      'Models',
      'MCP Gateway',
      'Software Intelligence',
      'Executions',
      'Observability',
      'Settings',
    ]) {
      expect(within(nav).queryByRole('link', { name: new RegExp(name) })).toBeNull(); // no fake destinations
      expect(within(nav).getByRole('menuitem', { name: new RegExp(name) })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
  });

  it('shows API connectivity from the shared contract-validated client', async () => {
    healthyApi();
    renderApp('/');
    expect(await screen.findByText('API: online')).toBeInTheDocument();
  });

  it('reports an unreachable API without breaking the shell', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderApp('/');

    expect(await screen.findByText('API: unreachable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('shows a loading state while the first page chunk downloads, then the shell with the page', async () => {
    healthyApi();
    renderApp('/');
    expect(screen.getByRole('status')).toHaveTextContent('Loading'); // HydrateFallback: React Router waits for the lazy route
    expect(screen.queryByRole('navigation')).toBeNull();

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('keeps the document title in sync with the route', async () => {
    healthyApi();
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(document.title).toBe('Overview · AgentOS');

    await act(() => router.navigate('/no-such-page'));
    expect(document.title).toBe('Page not found · AgentOS');
  });

  it('moves focus to the main region after navigation (but not on first load)', async () => {
    healthyApi();
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.getByRole('main')).not.toHaveFocus();

    await act(() => router.navigate('/no-such-page'));
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('shows not-found inside the shell, with navigation still available', async () => {
    healthyApi();
    renderApp('/definitely/not/here');

    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to overview' })).toBeInTheDocument();
  });

  it('a page that crashes shows a recoverable error inside the shell, without leaking details', async () => {
    healthyApi();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error('kaboom: secret internal detail');
    };
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <AppShell />,
          children: [
            {
              errorElement: <RouteErrorPage />,
              children: [
                { index: true, element: <div>home</div> },
                { path: 'boom', Component: Boom },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/boom'] },
    );
    renderWithProviders(<RouterProvider router={router} />);

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('The page hit an unexpected error.')).toBeInTheDocument();
    expect(screen.queryByText(/kaboom/)).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument(); // shell survived

    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    expect(await screen.findByText('home')).toBeInTheDocument();
  });
});

describe('application shell (phone)', () => {
  it('replaces the sidebar with a drawer opened from the header', async () => {
    healthyApi();
    setViewportWidth(500);
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    expect(screen.queryByRole('complementary')).toBeNull();
    const open = screen.getByRole('button', { name: 'Open navigation' });
    expect(open).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(open);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(open).toHaveAttribute('aria-expanded', 'true');
  });

  it('switches layout when the viewport crosses the breakpoint', async () => {
    healthyApi();
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();

    setViewportWidth(500);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });
});

describe('preferences in the shell', () => {
  it('lets the user switch to dark theme from the header', async () => {
    healthyApi();
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Theme' }));
    fireEvent.click(await screen.findByTitle('Dark'));

    expect(useUiPreferences.getState().themeMode).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
  });

  it('lets the user switch to Persian: text, direction and title all change, content does not remount', async () => {
    healthyApi();
    renderApp('/');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Overview' });

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Language' }));
    fireEvent.click(await screen.findByTitle('فارسی'));

    expect(root.dir).toBe('rtl');
    expect(root.lang).toBe('fa');
    expect(await screen.findByRole('heading', { level: 1, name: 'نمای کلی' })).toBe(heading); // same element, new text
    expect(screen.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('نمای کلی · AgentOS'));
    expect(useUiPreferences.getState().locale).toBe('fa');
  });

  it('lets the user switch back to English: text, direction and title change back, content does not remount', async () => {
    healthyApi();
    renderApp('/', { preferences: { locale: 'fa' } });
    const heading = await screen.findByRole('heading', { level: 1, name: 'نمای کلی' });
    expect(root.dir).toBe('rtl');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'زبان' }));
    fireEvent.click(await screen.findByTitle('English'));

    expect(root.dir).toBe('ltr');
    expect(root.lang).toBe('en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBe(heading);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Overview · AgentOS'));
    expect(useUiPreferences.getState().locale).toBe('en');
  });

  it('remembers the sidebar state', async () => {
    healthyApi();
    renderApp('/', { preferences: { sidebarCollapsed: true } });
    await screen.findByRole('heading', { level: 1 });
    expect(within(screen.getByRole('complementary')).getByRole('link', { name: 'A' })).toBeInTheDocument(); // collapsed brand
  });
});

describe('Persian (right-to-left) shell', () => {
  it('renders the whole shell in Persian, right-to-left', async () => {
    healthyApi();
    renderApp('/', { preferences: { locale: 'fa' } });

    expect(await screen.findByRole('heading', { level: 1, name: 'نمای کلی' })).toBeInTheDocument();
    expect(root.dir).toBe('rtl');
    expect(screen.getByRole('link', { name: 'رفتن به محتوای اصلی' })).toBeInTheDocument();
    expect(await screen.findByText('API: آنلاین')).toBeInTheDocument();
  });

  it('opens the phone drawer from the inline-start edge (right in RTL, left in LTR)', async () => {
    healthyApi();
    setViewportWidth(500);

    const { unmount } = renderApp('/', { preferences: { locale: 'fa' } });
    fireEvent.click(await screen.findByRole('button', { name: 'باز کردن ناوبری' }));
    await waitFor(() => expect(document.querySelector('.ant-drawer-right')).not.toBeNull());
    unmount();

    renderApp('/', { preferences: { locale: 'en' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    await waitFor(() => expect(document.querySelector('.ant-drawer-left')).not.toBeNull());
  });

  it('shows localized error text instead of English server messages', async () => {
    mockFetch(() => jsonResponse(notFoundError, 404));
    renderApp('/', { preferences: { locale: 'fa' } });
    expect(await screen.findByText('API: در دسترس نیست')).toBeInTheDocument();
  });
});
