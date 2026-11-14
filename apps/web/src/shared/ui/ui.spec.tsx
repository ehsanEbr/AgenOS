import { Button } from 'antd';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/errors';
import { renderWithProviders } from '../../test/render';
import { ErrorBoundary } from './ErrorBoundary';
import { Page } from './Page';
import { EmptyState, ErrorState, LoadingState } from './states';
import { useNotify } from './useNotify';

const apiError = (init: Partial<ConstructorParameters<typeof ApiClientError>[0]> = {}) =>
  new ApiClientError({
    kind: 'http',
    message: 'Agent 5f0d6c1e was not found',
    status: 404,
    code: 'agent_not_found',
    correlationId: 'srv-8b1f2c',
    ...init,
  });

describe('Page', () => {
  it('has exactly one h1 that labels its section, then the content', () => {
    renderWithProviders(
      <Page title="Agents" description="All agents" extra={<Button>Create</Button>}>
        <p>content</p>
      </Page>,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Agents' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Agents' })).toContainElement(heading);
    expect(screen.getByText('All agents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});

describe('LoadingState / EmptyState', () => {
  it('announces loading politely and uses a localized default label', () => {
    renderWithProviders(<LoadingState />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('localizes the loading label', () => {
    renderWithProviders(<LoadingState />, { preferences: { locale: 'fa' } });
    expect(screen.getByRole('status')).toHaveTextContent('در حال بارگذاری');
  });

  it('says what is empty and offers the next step', () => {
    renderWithProviders(
      <EmptyState description="No agents yet" action={<Button type="primary">Create agent</Button>} />,
    );
    expect(screen.getByText('No agents yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('shows a localized message for the error category, never the backend text', () => {
    renderWithProviders(<ErrorState error={apiError()} variant="inline" />);
    expect(screen.getByText('The requested item could not be found.')).toBeInTheDocument();
    expect(screen.queryByText(/5f0d6c1e/)).toBeNull();
  });

  it('shows the support reference when the error has a correlation id', () => {
    renderWithProviders(<ErrorState error={apiError()} />);
    expect(screen.getByText('Reference: srv-8b1f2c')).toBeInTheDocument();
  });

  it.each([
    [
      new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' }),
      'Cannot reach the server. Check your connection and try again.',
    ],
    [
      new ApiClientError({ kind: 'timeout', message: 'x', code: 'timeout' }),
      'The server took too long to respond. Try again.',
    ],
    [
      apiError({ status: 503, code: 'database_unavailable' }),
      'The service is temporarily unavailable. Try again shortly.',
    ],
    [apiError({ status: 403, code: 'forbidden' }), 'You do not have permission to do this.'],
    [new Error('unrelated'), 'An unexpected error occurred.'],
  ])('describes %s', (error, message) => {
    renderWithProviders(<ErrorState error={error} variant="inline" />);
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('is localized', () => {
    renderWithProviders(
      <ErrorState
        error={new ApiClientError({ kind: 'network', message: 'x', code: 'network_error' })}
        variant="inline"
      />,
      {
        preferences: { locale: 'fa' },
      },
    );
    expect(screen.getByText('مشکلی پیش آمد')).toBeInTheDocument();
    expect(screen.getByText(/ارتباط با سرور برقرار نشد/)).toBeInTheDocument();
  });

  it('offers retry only when a retry action is provided', () => {
    const { rerender } = renderWithProviders(<ErrorState error={apiError()} variant="inline" />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    const onRetry = vi.fn();
    rerender(<ErrorState error={apiError()} variant="inline" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders as a page-level result by default', () => {
    renderWithProviders(<ErrorState status="404" title="Page not found" description="Gone." />);
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(screen.getByText('Gone.')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('replaces a crashed subtree with a recoverable message, then recovers on retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let shouldCrash = true;
    function Fragile() {
      if (shouldCrash) throw new Error('render failure with internal detail');
      return <p>all good</p>;
    }
    renderWithProviders(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).toBeNull();

    shouldCrash = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('is translated', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Crash = () => {
      throw new Error('x');
    };
    renderWithProviders(
      <ErrorBoundary>
        <Crash />
      </ErrorBoundary>,
      { preferences: { locale: 'fa' } },
    );
    expect(screen.getByText('صفحه با یک خطای غیرمنتظره روبه‌رو شد.')).toBeInTheDocument();
  });
});

describe('useNotify', () => {
  function Trigger({ error }: { error?: unknown }) {
    const notify = useNotify();
    return (
      <>
        <Button onClick={() => notify.success('Saved', 'The agent was saved')}>ok</Button>
        <Button onClick={() => notify.error(error, 'Could not save')}>fail</Button>
      </>
    );
  }

  it('shows success notifications', async () => {
    renderWithProviders(<Trigger />);
    fireEvent.click(screen.getByRole('button', { name: 'ok' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('The agent was saved')).toBeInTheDocument();
  });

  it('turns a failed mutation into a localized message with the support reference', async () => {
    renderWithProviders(
      <Trigger error={apiError({ status: 409, code: 'conflict', message: 'raw backend text' })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/This conflicts with the current state/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Reference: srv-8b1f2c/)).toBeInTheDocument();
    expect(screen.queryByText(/raw backend text/)).toBeNull();
  });
});
