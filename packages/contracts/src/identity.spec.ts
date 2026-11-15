import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  changePasswordRequestSchema,
  emailSchema,
  loginRequestSchema,
  registerRequestSchema,
  utf8ByteLength,
} from './index';

describe('identity contracts', () => {
  it('counts UTF-8 bytes like the encoder does', () => {
    for (const sample of ['', 'abc', 'é', '€', '😀', 'aé€😀'])
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
  });

  it('normalizes an email so one address is one account', () => {
    expect(emailSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(emailSchema.safeParse('not an email').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.io`).success).toBe(false);
  });

  it('enforces the password policy on NEW passwords only', () => {
    const base = { email: 'a@b.co', displayName: 'A' };
    expect(
      registerRequestSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MIN_LENGTH) }).success,
    ).toBe(true);
    expect(
      registerRequestSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) }).success,
    ).toBe(false);
    // The limit is in bytes: 400 characters of 3-byte text is 1200 bytes.
    expect(registerRequestSchema.safeParse({ ...base, password: '€'.repeat(400) }).success).toBe(false);
    expect(
      registerRequestSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MAX_BYTES) }).success,
    ).toBe(true);
    expect(
      registerRequestSchema.safeParse({ ...base, password: 'x'.repeat(PASSWORD_MAX_BYTES + 1) }).success,
    ).toBe(false);
  });

  it('does not reveal the password policy when signing in, and defaults to cookie delivery', () => {
    const parsed = loginRequestSchema.parse({ email: 'A@B.co', password: 'short' });
    expect(parsed).toEqual({ email: 'a@b.co', password: 'short', delivery: 'cookie' });
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(PASSWORD_MAX_BYTES + 1) }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.co', password: 'pw', delivery: 'carrier-pigeon' }).success,
    ).toBe(false);
  });

  it('applies the policy to the new password of a password change, not the current one', () => {
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: 'old', newPassword: 'long enough pw' })
        .success,
    ).toBe(true);
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: 'old', newPassword: 'short' }).success,
    ).toBe(false);
  });
});
