import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import { type ReactNode, useState } from 'react';
import { ErrorBoundary } from '../../shared/ui/ErrorBoundary';
import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from './ThemeProvider';
import { createQueryClient } from './query-client';

interface AppProvidersProps {
  children: ReactNode;
  /** Injection points for tests. The app uses the defaults. */
  queryClient?: QueryClient;
  i18n?: I18n;
}

/**
 * Every cross-cutting provider, in one place and in dependency order:
 *   theme/direction -> translations -> error boundary -> server-state cache -> (router, rendered by App)
 * The error boundary sits inside theme and i18n so its fallback is themed and translated.
 * A future auth provider goes inside the query client (it will need to call the API) and outside the router.
 */
export function AppProviders({ children, queryClient, i18n }: AppProvidersProps) {
  const [client] = useState(() => queryClient ?? createQueryClient());

  return (
    <ThemeProvider>
      <I18nProvider i18n={i18n}>
        <ErrorBoundary>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </ErrorBoundary>
      </I18nProvider>
    </ThemeProvider>
  );
}
