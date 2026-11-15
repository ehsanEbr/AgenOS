import { describe, expect, it } from 'vitest';
import {
  addProjectMemberRequestSchema,
  auditEventSchema,
  createProjectRequestSchema,
  listProjectsQuerySchema,
  projectSlugSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
} from './index';

describe('project request contracts', () => {
  const organizationId = crypto.randomUUID();

  it('accepts only lower-case slugs of letters, digits and single hyphens, 2 to 48 characters', () => {
    for (const ok of ['ab', 'my-project', 'a1-b2-c3', 'x'.repeat(48)])
      expect(projectSlugSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      'a',
      'x'.repeat(49),
      'My-Project',
      'my_project',
      '-start',
      'end-',
      'dou--ble',
      'spa ce',
      'ünï',
      '',
      'a/b',
    ])
      expect(projectSlugSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('trims the name, bounds it, and treats an empty description as invalid (null removes it)', () => {
    const base = { organizationId, slug: 'proj' };
    expect(createProjectRequestSchema.parse({ ...base, name: '  Apollo  ' }).name).toBe('Apollo');
    expect(createProjectRequestSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ ...base, name: 'x'.repeat(101) }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ ...base, name: 'A', description: '' }).success).toBe(false);
    expect(
      createProjectRequestSchema.safeParse({ ...base, name: 'A', description: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(createProjectRequestSchema.safeParse({ name: 'A', slug: 'proj' }).success).toBe(false); // the selector is required
  });

  it('cannot change the organization or the slug of a project, and needs at least one field', () => {
    expect(updateProjectRequestSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateProjectRequestSchema.safeParse({ description: null }).success).toBe(true);
    expect(updateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ name: 'New', slug: 'other' }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ name: 'New', organizationId }).success).toBe(false);
  });

  it('defaults the list to active projects, requires the organization selector and bounds the page', () => {
    expect(listProjectsQuerySchema.parse({ organizationId })).toMatchObject({
      status: 'active',
      limit: 20,
      offset: 0,
    });
    expect(listProjectsQuerySchema.safeParse({}).success).toBe(false);
    expect(listProjectsQuerySchema.safeParse({ organizationId, status: 'deleted' }).success).toBe(false);
    expect(listProjectsQuerySchema.safeParse({ organizationId, limit: 1000 }).success).toBe(false);
  });

  it('identifies a member by user id and accepts only the three project roles', () => {
    const userId = crypto.randomUUID();
    for (const projectRole of ['project_admin', 'project_member', 'project_viewer'])
      expect(addProjectMemberRequestSchema.safeParse({ userId, projectRole }).success).toBe(true);
    for (const projectRole of ['owner', 'admin', 'viewer', '', undefined])
      expect(updateProjectMemberRequestSchema.safeParse({ projectRole }).success).toBe(false);
    expect(
      addProjectMemberRequestSchema.safeParse({ userId: 'a@example.com', projectRole: 'project_admin' })
        .success,
    ).toBe(false);
  });
});

describe('project audit events', () => {
  const [user, org, project] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const scope = { actorUserId: user, organizationId: org, projectId: project, resourceId: project };
  const parse = (action: string, resourceType: string, metadata: unknown) =>
    auditEventSchema.safeParse({ action, resourceType, result: 'success', ...scope, metadata }).success;

  it('records the creator grant with its origin, and no user-entered text anywhere', () => {
    expect(
      parse('project_member.added', 'project_member', {
        userId: user,
        role: 'project_admin',
        origin: 'project_created',
      }),
    ).toBe(true);
    for (const metadata of [
      { userId: user, role: 'project_admin' }, // origin is required
      { userId: user, role: 'project_admin', origin: 'somewhere' },
      { userId: user, role: 'project_admin', origin: 'added', name: 'Apollo' },
      { userId: user, role: 'owner', origin: 'added' }, // an organization role is not a project role
    ])
      expect(parse('project_member.added', 'project_member', metadata)).toBe(false);
  });

  it('distinguishes a removal from the cleanup after an organization membership ended', () => {
    const remove = (reason: string) =>
      parse('project_member.removed', 'project_member', { userId: user, role: 'project_viewer', reason });
    expect(remove('removed')).toBe(true);
    expect(remove('organization_membership_removed')).toBe(true);
    expect(remove('because')).toBe(false);
  });

  it('describes an update by field names only', () => {
    const update = (changedFields: unknown[]) => parse('project.updated', 'project', { changedFields });
    expect(update(['name', 'description'])).toBe(true);
    expect(update([])).toBe(false);
    expect(update(['slug'])).toBe(false);
  });

  it('keeps archive and restore free of metadata', () => {
    for (const action of ['project.archived', 'project.restored']) {
      expect(parse(action, 'project', {})).toBe(true);
      expect(parse(action, 'project', { reason: 'x' })).toBe(false);
    }
  });
});
