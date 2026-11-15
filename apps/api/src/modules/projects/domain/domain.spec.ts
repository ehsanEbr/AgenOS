import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../organizations';
import { changedProjectFields, isArchived, type ProjectRecord } from './project';
import {
  OrganizationContext,
  ProjectContext,
  ProjectScope,
  projectScopeOf,
  requireProjectScope,
} from './project-context';
import { visibilityFor } from './visibility';

const tenant = (organizationId = randomUUID()): TenantContext => ({
  organizationId,
  userId: randomUUID(),
  role: 'member',
});
const project = (organizationId: string): ProjectRecord => ({
  id: randomUUID(),
  organizationId,
  name: 'P',
  slug: 'p-1',
  description: null,
  status: 'active',
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('ProjectScope and ProjectContext (fail closed)', () => {
  it('derives a scope from a genuine context, carrying that project and its organization', () => {
    const t = tenant();
    const p = project(t.organizationId);
    const context = ProjectContext.create(t, p, 'project_viewer', new Set(['project.read']));
    expect(projectScopeOf(context)).toMatchObject({ organizationId: p.organizationId, projectId: p.id });
    expect(context.scope).toBeInstanceOf(ProjectScope);
  });

  it('refuses to build a context for a tenant that is not the organization of the project', () => {
    expect(() => ProjectContext.create(tenant(), project(randomUUID()), null, new Set())).toThrow(
      /not the organization/,
    );
  });

  it('refuses to derive a scope from anything that is not a ProjectContext', () => {
    const t = tenant();
    const lookAlike = {
      tenant: t,
      project: project(t.organizationId),
      projectRole: null,
      permissions: new Set(),
    };
    for (const value of [undefined, null, lookAlike, {}, 'project'])
      expect(() => projectScopeOf(value as never)).toThrow(/ProjectContext/);
  });

  it('refuses every scope that is not a genuine one with valid ids, before any query could be built', () => {
    const [org, proj] = [randomUUID(), randomUUID()];
    const refused: unknown[] = [
      undefined,
      null,
      '',
      proj, // a bare id
      { organizationId: org, projectId: proj }, // a look-alike object
      ProjectScope.of('', proj),
      ProjectScope.of(org, ''),
      ProjectScope.of(org, "x' OR '1'='1"),
      ProjectScope.of('not-a-uuid', proj),
      Object.create(ProjectScope.prototype), // right prototype, no ids
    ];
    for (const value of refused) expect(() => requireProjectScope(value)).toThrow(/ProjectScope/);
    expect(requireProjectScope(ProjectScope.of(org, proj)).projectId).toBe(proj);
  });

  it('carries the organization scope in an OrganizationContext built from a tenant', () => {
    const t = tenant();
    expect(OrganizationContext.create(t).scope.organizationId).toBe(t.organizationId);
    expect(() => OrganizationContext.create({ ...t, organizationId: 'x' })).toThrow();
  });
});

describe('visibility', () => {
  it('sees every project of the organization with implicit access, and only explicit memberships without it', () => {
    const user = randomUUID();
    expect(visibilityFor(user, true)).toEqual({ kind: 'organization', userId: user });
    expect(visibilityFor(user, false)).toEqual({ kind: 'explicit', userId: user });
  });
});

describe('project lifecycle rules', () => {
  const base = project(randomUUID());

  it('knows archived from active', () => {
    expect(isArchived({ status: 'archived' })).toBe(true);
    expect(isArchived({ status: 'active' })).toBe(false);
  });

  it('reports the fields that really change, by name, and none when nothing does', () => {
    expect(changedProjectFields(base, {})).toEqual([]);
    expect(changedProjectFields(base, { name: 'P' })).toEqual([]); // same value
    expect(changedProjectFields(base, { name: 'Q' })).toEqual(['name']);
    expect(changedProjectFields(base, { description: null })).toEqual([]); // already null
    expect(changedProjectFields(base, { description: 'text' })).toEqual(['description']);
    expect(changedProjectFields({ ...base, description: 'text' }, { name: 'Q', description: null })).toEqual([
      'name',
      'description',
    ]);
  });
});
