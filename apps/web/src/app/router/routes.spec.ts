import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { homeRoutes } from '../../features/home';
import { organizationProjectsPath, projectMembersPath, projectPath } from '../../features/projects';
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
      'projects',
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
    const shell = guarded().children![0]!;
    expect(shell.path).toBe('/');
    expect(shell.errorElement).toBeDefined();
    const group = shell.children![0]!;
    expect(group.errorElement).toBeDefined();
    expect(group.children!.at(-1)?.path).toBe('*');
  });
});

/** The pathless route whose element is the session guard: everything private is its descendant. */
const guarded = () => routes.find((route) => route.path === undefined && route.children?.[0]?.path === '/')!;
const publicGroup = () => routes.find((route) => route !== guarded())!;

describe('route table: the session guard (ADR-0012 D4)', () => {
  it('has exactly two top-level groups: the public pages and the guarded application', () => {
    expect(routes).toHaveLength(2);
    expect(publicGroup().children!.map((route) => route.path)).toEqual(['sign-in', 'sign-up']);
    expect(guarded().element).toBeDefined();
  });

  it('puts the sign-in and sign-up pages outside the guard and everything else inside it', () => {
    for (const path of ['/sign-in', '/sign-up']) {
      const matches = matchRoutes(routes, path)!;
      expect(matches.some((match) => match.route === publicGroup())).toBe(true);
      expect(matches.some((match) => match.route === guarded())).toBe(false);
    }
    for (const path of ['/', '/projects', '/anything/at/all', '/sign-in/extra']) {
      const matches = matchRoutes(routes, path)!;
      expect(
        matches.some((match) => match.route === guarded()),
        path,
      ).toBe(true);
      expect(
        matches.some((match) => match.route === publicGroup()),
        path,
      ).toBe(false);
    }
  });

  it('loads the public pages lazily and gives each a translated title', () => {
    for (const route of publicGroup().children!) {
      expect(typeof route.lazy).toBe('function');
      expect(route.handle).toMatchObject({ titleKey: expect.stringMatching(/^auth:/) });
    }
  });
});

describe('route table: the organization routes (ADR-0012 D2)', () => {
  const leafOf = (path: string) => matchRoutes(routes, path)!.at(-1)!;
  const ORGANIZATION = '00000000-0000-4000-8000-000000000001';

  it('/projects is a page of the guarded shell, not a catch-all, and is lazy', () => {
    const leaf = leafOf('/projects').route;
    expect(leaf.path).toBe('projects');
    expect(typeof leaf.lazy).toBe('function');
    expect(matchRoutes(routes, '/projects')!.some((match) => match.route === guarded())).toBe(true);
  });

  it('nests the project pages under the organization route exactly as the ADR lists them', () => {
    const matches = matchRoutes(routes, `/organizations/${ORGANIZATION}/projects`)!;
    const layout = matches.find((match) => match.route.path === 'organizations/:organizationId');
    expect(layout, 'the organization layout is an ancestor of the project pages').toBeDefined();
    expect(layout!.params).toEqual({ organizationId: ORGANIZATION });
    const projects = matches.find((match) => match.route.path === 'projects');
    expect(projects, 'the projects route nests below the organization layout').toBeDefined();
    expect(matches.at(-1)!.route.index).toBe(true); // the project list is the index of `projects`
    expect(typeof matches.at(-1)!.route.lazy).toBe('function');
    expect(matches.some((match) => match.route === guarded())).toBe(true);
    expect(typeof layout!.route.lazy).toBe('function');
  });

  it('the bare organization path is an index route (a redirect to its projects), not the not-found page', () => {
    const leaf = leafOf(`/organizations/${ORGANIZATION}`).route;
    expect(leaf.index).toBe(true);
    expect(leaf.path).not.toBe('*');
  });

  it('a path the organization route does not define is still the not-found page', () => {
    expect(leafOf(`/organizations/${ORGANIZATION}/unknown`).route.path).toBe('*');
    expect(leafOf('/organizations').route.path).toBe('*');
  });

  it('every other path of the shell group keeps the order: pages first, the catch-all last', () => {
    const group = guarded().children![0]!.children![0]!;
    expect(group.children!.at(-1)?.path).toBe('*');
    expect(group.children!.map((route) => route.path ?? 'index')).toEqual([
      'index',
      'projects',
      'organizations/:organizationId',
      '*',
    ]);
  });
});

describe('route table: the project pages (ADR-0012 D2)', () => {
  const ORGANIZATION = '00000000-0000-4000-8000-000000000001';
  const PROJECT = '10000000-0000-4000-8000-000000000002';
  const matchesOf = (path: string) => matchRoutes(routes, path)!;
  const paths = (path: string) =>
    matchesOf(path).map((match) => match.route.path ?? (match.route.index ? '(index)' : '(pathless)'));

  it('has exactly the three pages of the ADR below the organization layout: list, details, members', () => {
    expect(paths(organizationProjectsPath(ORGANIZATION)).slice(-3)).toEqual([
      'organizations/:organizationId',
      'projects',
      '(index)',
    ]);
    expect(paths(projectPath(ORGANIZATION, PROJECT)).slice(-4)).toEqual([
      'organizations/:organizationId',
      'projects',
      ':projectId',
      '(index)',
    ]);
    expect(paths(projectMembersPath(ORGANIZATION, PROJECT)).slice(-4)).toEqual([
      'organizations/:organizationId',
      'projects',
      ':projectId',
      'members',
    ]);
  });

  it('the paths the feature builds are the paths the route table serves, with their parameters', () => {
    expect(matchesOf(projectPath(ORGANIZATION, PROJECT)).at(-1)!.params).toEqual({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
    });
    expect(matchesOf(projectMembersPath(ORGANIZATION, PROJECT)).at(-1)!.params).toEqual({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
    });
  });

  it('every page is lazy, below the session guard, and nothing else is a page of a project', () => {
    for (const path of [
      organizationProjectsPath(ORGANIZATION),
      projectPath(ORGANIZATION, PROJECT),
      projectMembersPath(ORGANIZATION, PROJECT),
    ]) {
      expect(typeof matchesOf(path).at(-1)!.route.lazy, path).toBe('function');
      expect(
        matchesOf(path).some((match) => match.route === guarded()),
        path,
      ).toBe(true);
    }
    expect(matchesOf(`${projectPath(ORGANIZATION, PROJECT)}/unknown`).at(-1)!.route.path).toBe('*');
    expect(matchesOf(`${projectMembersPath(ORGANIZATION, PROJECT)}/more`).at(-1)!.route.path).toBe('*');
  });

  it("gives each page a static title, so a project's name can never reach the document title", () => {
    const titles = [
      organizationProjectsPath(ORGANIZATION),
      projectPath(ORGANIZATION, PROJECT),
      projectMembersPath(ORGANIZATION, PROJECT),
    ].map((path) => (matchesOf(path).at(-1)!.route.handle as { titleKey: string }).titleKey);
    expect(titles).toEqual(['projects:list.title', 'projects:details.title', 'projects:members.title']);
  });
});
