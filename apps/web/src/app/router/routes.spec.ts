import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { homeRoutes } from '../../features/home';
import { NAV_ITEMS } from '../layouts/navigation';
import { routes } from './routes';

describe('route table', () => {
  it('every "available" navigation entry has a real route (not just the catch-all)', () => {
    for (const item of NAV_ITEMS.filter((i) => i.status === 'available')) {
      const matches = matchRoutes(routes, item.to);
      const leaf = matches?.at(-1)?.route;
      expect(leaf, `no route for ${item.to}`).toBeDefined();
      expect(leaf?.path, `${item.to} only matches the not-found route`).not.toBe('*');
    }
  });

  it('planned entries are placeholders: they do not already have a page behind them', () => {
    for (const item of NAV_ITEMS.filter((i) => i.status === 'planned')) {
      const leaf = matchRoutes(routes, item.to)?.at(-1)?.route;
      expect(leaf?.path, `${item.to} has a route but is still marked planned`).toBe('*');
    }
  });

  it('navigation entries have unique keys and paths, in the specified order', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.to)).size).toBe(NAV_ITEMS.length);
    expect(NAV_ITEMS.map((i) => i.key)).toEqual([
      'overview',
      'agents',
      'models',
      'mcpGateway',
      'softwareIntelligence',
      'executions',
      'observability',
      'settings',
    ]);
  });

  it('feature pages are code-split: routes load their component lazily', () => {
    for (const route of homeRoutes) expect(typeof route.lazy).toBe('function');
  });

  it('nests feature routes under the shell and a page-level error boundary', () => {
    const shell = routes[0]!;
    expect(shell.path).toBe('/');
    expect(shell.errorElement).toBeDefined();
    const group = shell.children![0]!;
    expect(group.errorElement).toBeDefined();
    expect(group.children!.at(-1)?.path).toBe('*');
  });
});
