import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { ApiClientError } from '../shared/api/client';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';
import { routes } from './router';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        // Retrying a 4xx never helps; transient failures get a couple of attempts.
        retry: (count, error) =>
          !(error instanceof ApiClientError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  });
}

const router = createBrowserRouter(routes);

export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <ConfigProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ConfigProvider>
    </ErrorBoundary>
  );
}
