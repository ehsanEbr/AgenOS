import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, auditEventSchema } from './index';

describe('audit event contracts', () => {
  const user = crypto.randomUUID();

  it('lists the identity actions and nothing from later phases', () => {
    expect(AUDIT_ACTIONS).toEqual([
      'auth.registered',
      'auth.login_succeeded',
      'auth.login_failed',
      'auth.login_throttled',
      'auth.logout',
      'auth.logout_all',
      'auth.password_changed',
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
});
