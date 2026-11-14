import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { AppProviders } from './providers/AppProviders';
import { createAppRouter } from './router/create-router';

export function App() {
  // Created inside the component (not at import time) so importing App never has side effects.
  const [router] = useState(createAppRouter);

  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
