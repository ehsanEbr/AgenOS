import { describe, expect, it } from 'vitest';
import { formatDate } from './format';
import { organizationProjectsPath, projectMembersPath, projectPath } from './paths';
import { projectKeys } from './queries';

/** The small pure parts of the projects feature. The pages are tested through the real application in `app/router/project-routes.spec.tsx`. */

describe('project query keys', () => {
  it('live under the private root "projects", so the session lifecycle removes them with the session', () => {
    for (const key of [
      projectKeys.all,
      projectKeys.lists(),
      projectKeys.list('o', 'active', 0),
      projectKeys.detail('p'),
      projectKeys.members('p', 0),
    ])
      expect(key[0]).toBe('projects');
  });

  it('a list key contains the organization, the filter and the page, so no list is ever shown for another request', () => {
    const base = projectKeys.list('org-a', 'active', 0);
    expect(projectKeys.list('org-b', 'active', 0)).not.toEqual(base);
    expect(projectKeys.list('org-a', 'archived', 0)).not.toEqual(base);
    expect(projectKeys.list('org-a', 'active', 20)).not.toEqual(base);
    expect(base).toContain('org-a');
  });

  it('a member page key contains the project and the page', () => {
    expect(projectKeys.members('p1', 0)).not.toEqual(projectKeys.members('p2', 0));
    expect(projectKeys.members('p1', 0)).not.toEqual(projectKeys.members('p1', 20));
  });

  it('a detail key is below the "detail" group, so all details can be invalidated at once', () => {
    expect(projectKeys.detail('p').slice(0, 2)).toEqual(projectKeys.details());
  });
});

describe('project paths', () => {
  it('are the routes of ADR-0012 D2', () => {
    expect(organizationProjectsPath('o1')).toBe('/organizations/o1/projects');
    expect(projectPath('o1', 'p1')).toBe('/organizations/o1/projects/p1');
    expect(projectMembersPath('o1', 'p1')).toBe('/organizations/o1/projects/p1/members');
  });

  it('encode what they are given, so an id can never add a path segment', () => {
    expect(organizationProjectsPath('a/b')).toBe('/organizations/a%2Fb/projects');
    expect(projectPath('o', '../x')).toBe('/organizations/o/projects/..%2Fx');
  });
});

describe('formatDate', () => {
  it('formats a date in the language of the interface', () => {
    expect(formatDate('2026-03-02T09:00:00.000Z', 'en')).toBe('Mar 2, 2026');
  });

  it('follows the Persian locale, with its own digits', () => {
    const fa = formatDate('2026-03-02T09:00:00.000Z', 'fa');
    expect(fa).not.toBe(formatDate('2026-03-02T09:00:00.000Z', 'en'));
    expect(fa).toMatch(/[۰-۹]/);
  });

  it('gives an empty string for something that is not a date', () => {
    expect(formatDate('not a date', 'en')).toBe('');
  });
});
