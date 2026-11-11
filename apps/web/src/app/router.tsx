import { Button, Result } from 'antd';
import { Link, type RouteObject } from 'react-router-dom';
import { HomePage } from '../features/home/HomePage';
import { AppLayout } from './AppLayout';

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: '*',
        element: (
          <Result
            status="404"
            title="Page not found"
            extra={
              <Link to="/">
                <Button type="primary">Back to home</Button>
              </Link>
            }
          />
        ),
      },
    ],
  },
];
