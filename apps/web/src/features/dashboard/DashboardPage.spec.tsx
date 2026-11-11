import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const job = (status: string, extra: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  status,
  message: 'hello',
  output: null,
  error: null,
  attempts: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  ...extra,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderPage(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => handler(url, init)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

const readyOk = json.bind(null, 200, {
  status: 'ok',
  checks: { database: { status: 'up', latencyMs: 3 }, redis: { status: 'up', latencyMs: 1 } },
});

describe('DashboardPage', () => {
  it('shows healthy dependencies', async () => {
    renderPage(() => readyOk());
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
    expect(screen.getByText('database')).toBeInTheDocument();
  });

  it('shows a warning when a dependency is down', async () => {
    renderPage(() =>
      json(503, {
        status: 'degraded',
        checks: { database: { status: 'down', error: 'unreachable' }, redis: { status: 'up' } },
      }),
    );
    expect(await screen.findByText('Some services are unavailable')).toBeInTheDocument();
  });

  it('shows an error when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Cannot reach the API')).toBeInTheDocument();
  });

  it('submits a job and displays its result once completed', async () => {
    renderPage((url, init) => {
      if (url.endsWith('/health/ready')) return readyOk();
      if (init?.method === 'POST') return json(202, job('QUEUED'));
      return json(200, job('COMPLETED', { output: 'pong: hello', attempts: 1 }));
    });
    await userEvent.click(await screen.findByRole('button', { name: /submit job/i }));

    await waitFor(() => expect(screen.getByText('pong: hello')).toBeInTheDocument());
    expect(screen.getByText('COMPLETED')).toBeInTheDocument();
  });
});
