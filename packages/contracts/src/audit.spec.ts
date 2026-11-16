import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, auditEventSchema } from './index';

describe('audit event contracts', () => {
  const user = crypto.randomUUID();

  it('lists the identity, organization and project actions and nothing from later phases', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'auth.registered',
      'auth.login_succeeded',
      'auth.login_failed',
      'auth.login_throttled',
      'auth.logout',
      'auth.logout_all',
      'auth.password_changed',
      'auth.password_change_failed',
      'organization.created',
      'organization.updated',
      'membership.added',
      'membership.removed',
      'membership.role_changed',
      'organization.owner_granted',
      'organization.owner_revoked',
      'project.created',
      'project.updated',
      'project.archived',
      'project.restored',
      'project_member.added',
      'project_member.role_changed',
      'project_member.removed',
    ]);
  });

  it('applies defaults for the optional scope fields', () => {
    const event = auditEventSchema.parse({
      action: 'auth.logout',
      resourceType: 'session',
      result: 'success',
      metadata: {},
      actorUserId: user,
    });
    expect(event).toMatchObject({ organizationId: null, projectId: null, resourceId: null });
  });

  it('rejects metadata that is not part of the action schema: a secret cannot ride along', () => {
    const attempt = (metadata: Record<string, unknown>) =>
      auditEventSchema.safeParse({
        action: 'auth.login_succeeded',
        resourceType: 'session',
        result: 'success',
        metadata,
      }).success;
    expect(attempt({ delivery: 'cookie' })).toBe(true);
    expect(attempt({ delivery: 'cookie', token: 'abc' })).toBe(false);
    expect(attempt({ delivery: 'cookie', password: 'abc' })).toBe(false);
    expect(attempt({ delivery: 'smoke-signal' })).toBe(false);
  });

  it('pins the result of each action (a failed sign-in cannot be recorded as a success)', () => {
    expect(
      auditEventSchema.safeParse({
        action: 'auth.login_failed',
        resourceType: 'user',
        result: 'success',
        metadata: {},
      }).success,
    ).toBe(false);
  });

  it('describes a failed password change by its reason only, and nothing else can ride along', () => {
    const attempt = (metadata: Record<string, unknown>, result = 'failure') =>
      auditEventSchema.safeParse({
        action: 'auth.password_change_failed',
        resourceType: 'user',
        result,
        metadata,
      }).success;
    expect(attempt({ reason: 'wrong_current_password' })).toBe(true);
    expect(attempt({ reason: 'rate_limited' })).toBe(true);
    expect(attempt({ reason: 'because I said so' })).toBe(false);
    expect(attempt({})).toBe(false);
    expect(attempt({ reason: 'wrong_current_password', currentPassword: 'hunter2' })).toBe(false);
    expect(attempt({ reason: 'wrong_current_password', newPassword: 'hunter3' })).toBe(false);
    expect(attempt({ reason: 'rate_limited' }, 'success')).toBe(false); // a failed attempt cannot be recorded as a success
  });
});
