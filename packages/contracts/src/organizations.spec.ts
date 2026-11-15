import { describe, expect, it } from 'vitest';
import {
  addMemberRequestSchema,
  createOrganizationRequestSchema,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
} from './index';

describe('organization request contracts', () => {
  it('trims and bounds the organization name', () => {
    expect(createOrganizationRequestSchema.parse({ name: '  Acme  ' })).toEqual({ name: 'Acme' });
    expect(createOrganizationRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createOrganizationRequestSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(updateOrganizationRequestSchema.safeParse({}).success).toBe(false);
  });

  it('canonicalizes the email of a new member the same way sign-in does', () => {
    expect(addMemberRequestSchema.parse({ email: '  Ada@Example.COM ', role: 'member' })).toEqual({
      email: 'ada@example.com',
      role: 'member',
    });
  });

  it('accepts only the four roles', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'])
      expect(updateMemberRequestSchema.safeParse({ role }).success).toBe(true);
    for (const role of ['root', 'OWNER', '', undefined])
      expect(updateMemberRequestSchema.safeParse({ role }).success).toBe(false);
  });
});
