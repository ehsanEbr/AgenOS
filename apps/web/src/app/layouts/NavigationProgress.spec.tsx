import { act, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/render';
import { NavigationProgress } from './NavigationProgress';

describe('NavigationProgress', () => {
  it('appears only while a route is loading', async () => {
    let finishLoading!: () => void;
    const slow = new Promise<null>((resolve) => {
      finishLoading = () => resolve(null);
    });
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <NavigationProgress />,
          children: [
            { index: true, element: <p>start</p> },
            { path: 'slow', loader: () => slow, element: <p>done</p> },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );
    renderWithProviders(<RouterProvider router={router} />);
    expect(screen.queryByRole('progressbar')).toBeNull();

    let navigation!: Promise<void>;
    act(() => {
      navigation = router.navigate('/slow');
    });
    expect(await screen.findByRole('progressbar', { name: 'Loading page' })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    await act(async () => {
      finishLoading();
      await navigation;
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
