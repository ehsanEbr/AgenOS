import { QueryClient } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { i18n as I18n } from 'i18next';
import { type ReactElement, type ReactNode } from 'react';
import { RouterProvider } from 'react-router';
import { createI18n } from '../app/i18n/create-i18n';
import { AppProviders } from '../app/providers/AppProviders';
import { createQueryClient } from '../app/providers/query-client';
import { createTestRouter } from '../app/router/create-router';
import { useUiPreferences, type UiPreferences } from '../app/state/ui-preferences.store';
import { requireSessionLifecycle, type SessionValue } from '../features/auth';
import { testUser } from './fixtures/api';

/**
 * A query client with the application's real defaults and retry policy, except that retries are immediate so tests do
 * not wait for backoff.
 */
export function createTestQueryClient(session?: SessionValue): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
  });
  if (session) requireSessionLifecycle(client).transition(session);
  return client;
}

/** The session tests start in unless they ask for another: signed in as the fixture user (the whole app is behind the guard). */
export const SIGNED_IN: SessionValue = {
  status: 'authenticated',
  user: { id: testUser.id, email: testUser.email, displayName: testUser.displayName },
};

/** The signed-out session, for tests that start without a user. */
export const SIGNED_OUT: SessionValue = { status: 'anonymous' };

interface Options extends Omit<RenderOptions, 'wrapper'> {
  /** Preferences to start with (theme, language, sidebar). Defaults: English, light. */
  preferences?: Partial<UiPreferences>;
  queryClient?: QueryClient;
  /**
   * The session to start in. Default: signed in as the fixture user. Pass `{ status: 'anonymous' }` to start signed out, or `null`
   * to leave the session untouched so the app probes `GET /me` through the (mocked) API exactly like a browser does on load.
   */
  session?: SessionValue | null;
}

function setup({ preferences, queryClient, session }: Options) {
  if (preferences) useUiPreferences.setState(preferences);
  const locale = useUiPreferences.getState().locale;
  const client = queryClient ?? createTestQueryClient();
  if (session !== null) requireSessionLifecycle(client).transition(session ?? SIGNED_IN);
  return { queryClient: client, i18n: createI18n(locale) };
}

/** Renders a component inside the real application providers (theme, direction, i18n, query cache). */
type AppRender = RenderResult & { queryClient: QueryClient; i18n: I18n };

export function renderWithProviders(ui: ReactElement, options: Options = {}): AppRender {
  const { queryClient, i18n } = setup(options);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders queryClient={queryClient} i18n={i18n}>
      {children}
    </AppProviders>
  );
  return { queryClient, i18n, ...render(ui, { wrapper, ...options }) };
}

/** Renders the whole application (providers + shell + real route table) at a URL, like a user arriving there. */
export function renderApp(
  path = '/',
  options: Options = {},
): AppRender & { router: ReturnType<typeof createTestRouter> } {
  const { queryClient, i18n } = setup(options);
  const router = createTestRouter([path]);
  const result = render(
    <AppProviders queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </AppProviders>,
    options,
  );
  return { router, queryClient, i18n, ...result };
}
