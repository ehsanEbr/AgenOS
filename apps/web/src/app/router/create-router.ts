import { createBrowserRouter, createMemoryRouter } from 'react-router';
import { routes } from './routes';

/** The router the browser uses (History API). Created once by `App`. */
export const createAppRouter = () => createBrowserRouter(routes);

/** The same route table with in-memory history. Tests use this to render any URL without a browser. */
export const createTestRouter = (initialEntries: string[] = ['/']) =>
  createMemoryRouter(routes, { initialEntries });
