import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  canonicalizeEmail,
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

  // Every code point JavaScript's trim() strips (computed from the engine, then pinned here): tab, line feed, vertical tab, form feed,
  // carriage return, space, no-break space, Ogham space, the en/em/thin/hair spaces, line and paragraph separators, narrow no-break
  // space, medium mathematical space, ideographic space and the byte order mark.
  const TRIMMED_BY_JAVASCRIPT = [
    0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  ].map((codePoint) => String.fromCodePoint(codePoint));

  it('canonicalizeEmail strips EVERY whitespace character JavaScript trims, at both ends, and lower-cases', () => {
    for (const space of TRIMMED_BY_JAVASCRIPT) {
      expect(
        canonicalizeEmail(`${space}Alice@Example.COM${space}`),
        `U+${space.codePointAt(0)?.toString(16)}`,
      ).toBe('alice@example.com');
    }
    const blanksBefore = [0x9, 0x20, 0xa0, 0xa, 0x20].map((c) => String.fromCodePoint(c)).join('');
    const blanksAfter = [0x20, 0x3000, 0xfeff].map((c) => String.fromCodePoint(c)).join('');
    expect(canonicalizeEmail(`${blanksBefore}A@B.co${blanksAfter}`)).toBe('a@b.co');
    // The set above is exactly what the engine trims (so it cannot silently diverge from the database constraint's assumptions).
    const trimmedByEngine: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint++)
      if (String.fromCharCode(codePoint).trim() === '') trimmedByEngine.push(String.fromCharCode(codePoint));
    expect(trimmedByEngine.sort()).toEqual([...TRIMMED_BY_JAVASCRIPT].sort());
  });

  it('canonicalizeEmail is idempotent and leaves inner characters alone (inner spaces are left to validation)', () => {
    for (const raw of ['  A@B.co ', 'x+Tag@Example.com', "O'Brien@Example.com", 'a b@example.com']) {
      expect(canonicalizeEmail(canonicalizeEmail(raw))).toBe(canonicalizeEmail(raw));
    }
    expect(canonicalizeEmail('a b@example.com')).toBe('a b@example.com');
  });

  it('emailSchema is canonicalizeEmail followed by validation: one implementation, and its output is always database-canonical', () => {
    const corpus = [
      'alice@example.com',
      `  ALICE@EXAMPLE.COM${String.fromCodePoint(0x9)}`,
      `${String.fromCodePoint(0xa0)}Alice@Example.com${String.fromCodePoint(0x3000)}`,
      "O'Brien+Tag_1@Sub-Domain.Example.org",
      'a.b@example.com',
      'ä@example.com',
      `${String.fromCodePoint(0x130)}stanbul@example.com`,
      `${String.fromCodePoint(0xff41)}@example.com`,
      'a@exämple.com',
      'a b@example.com',
      'not an email',
      '',
    ];
    for (const raw of corpus) {
      const parsed = emailSchema.safeParse(raw);
      if (!parsed.success) continue;
      expect(parsed.data).toBe(canonicalizeEmail(raw)); // the schema adds nothing of its own
      // The invariant `identity.user_email_canonical` enforces: printable ASCII only (no whitespace, no control characters), no upper case.
      expect(parsed.data).toMatch(/^[!-~]+$/);
      expect(parsed.data).toBe(parsed.data.toLowerCase());
    }
    expect(emailSchema.safeParse('ä@example.com').success).toBe(false); // non-ASCII stays rejected
  });

  it('keeps generating the OpenAPI document (the request schemas are described from these schemas)', () => {
    expect(() => z.toJSONSchema(emailSchema, { io: 'input' })).not.toThrow();
    expect(() => z.toJSONSchema(loginRequestSchema, { io: 'input' })).not.toThrow();
    expect(() => z.toJSONSchema(registerRequestSchema, { io: 'input' })).not.toThrow();
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
