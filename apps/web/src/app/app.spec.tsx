import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';
import { AppLayout } from './AppLayout';
import { HomePage } from '../features/home/HomePage';

function renderShell(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('application shell', () => {
  it('renders the home page and reports a reachable API', async () => {
    renderShell(async () =>
      Response.json({ status: 'ok', service: 'api', uptimeSeconds: 1 }, { status: 200 }),
    );
    expect(screen.getByRole('heading', { name: 'AgentOS', level: 2 })).toBeInTheDocument();
    expect(await screen.findByText('API: ok')).toBeInTheDocument();
  });

  it('reports an unreachable API without breaking the shell', async () => {
    renderShell(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await screen.findByText('API: unreachable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AgentOS', level: 2 })).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('shows a recoverable error instead of a blank page', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('render failure');
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    spy.mockRestore();
  });
});
