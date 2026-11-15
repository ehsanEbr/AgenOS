import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatPasswordHash, needsRehash, parsePasswordHash } from './password-hash';
import { PASSWORD_HASH_ACCEPTED, PASSWORD_HASH_POLICY } from './password-policy';
import {
  TOUCH_INTERVAL_MS,
  expiryTimes,
  rejectionOf,
  shouldTouch,
  slideIdleExpiry,
  type SessionRecord,
} from './session';
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from './session-token';

describe('the approved password hashing policy is pinned', () => {
  it('equals exactly what the architecture review approved (changing any value must be a deliberate, reviewed edit)', () => {
    expect(PASSWORD_HASH_POLICY).toEqual({
      version: 1,
      costLog2: 17, // N = 2^17 = 131072
      blockSize: 8, // r
      parallelization: 1, // p
      keyLength: 32,
      saltLength: 16,
      maxMemoryBytes: 256 * 1024 * 1024,
      maxConcurrentHashes: 2,
      slotWaitMs: 5_000,
    });
  });

  it('needs 128 MiB per hash and keeps an explicit ceiling of twice that', () => {
    const { costLog2, blockSize, maxMemoryBytes } = PASSWORD_HASH_POLICY;
    const required = 128 * 2 ** costLog2 * blockSize;
    expect(required).toBe(128 * 1024 * 1024);
    expect(maxMemoryBytes).toBe(2 * required);
  });

  it('accepts, from storage, only parameters that fit the memory ceiling', () => {
    const largest = 128 * 2 ** PASSWORD_HASH_ACCEPTED.costLog2.max * PASSWORD_HASH_ACCEPTED.blockSize.max;
    expect(largest).toBeLessThan(PASSWORD_HASH_POLICY.maxMemoryBytes);
    expect(PASSWORD_HASH_ACCEPTED.costLog2.max).toBeGreaterThanOrEqual(PASSWORD_HASH_POLICY.costLog2);
  });

  it('is what Node needs to be told explicitly: the default memory limit rejects N = 2^17', () => {
    const attempt = () => scryptSync('pw', Buffer.alloc(16), 32, { N: 2 ** 17, r: 8, p: 1 });
    expect(attempt).toThrow(/memory limit|ERR_CRYPTO_INVALID_SCRYPT_PARAMS/i);
  });
});

describe('the stored password hash format', () => {
  const parts = {
    version: 1,
    costLog2: 17,
    blockSize: 8,
    parallelization: 1,
    keyLength: 32,
    salt: randomBytes(16),
    hash: randomBytes(32),
  };

  it('round-trips and carries its own parameters', () => {
    const stored = formatPasswordHash(parts);
    expect(stored).toMatch(/^\$scrypt\$v=1\$ln=17,r=8,p=1,len=32\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(parsePasswordHash(stored)).toEqual(parts);
  });

  it('is marked for upgrade only when it differs from the current policy', () => {
    expect(needsRehash(parts)).toBe(false);
    expect(needsRehash({ ...parts, costLog2: 15 })).toBe(true);
    expect(needsRehash({ ...parts, parallelization: 2 })).toBe(true);
    expect(needsRehash({ ...parts, salt: randomBytes(24) })).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['another algorithm', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
    ['an unknown version', formatPasswordHash({ ...parts, version: 2 })],
    ['a cost above what the memory ceiling allows', formatPasswordHash({ ...parts, costLog2: 30 })],
    ['a cost below the accepted minimum', formatPasswordHash({ ...parts, costLog2: 10 })],
    ['a block size the policy does not use', formatPasswordHash({ ...parts, blockSize: 16 })],
    ['a hash of the wrong length', formatPasswordHash({ ...parts, hash: randomBytes(16) })],
    ['a salt that is too short', formatPasswordHash({ ...parts, salt: randomBytes(4) })],
    ['missing fields', '$scrypt$v=1$ln=17,r=8,p=1,len=32$onlysalt'],
    ['extra fields', `${formatPasswordHash(parts)}$extra`],
    [
      'non-canonical base64url',
      formatPasswordHash(parts).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) + '==',
    ],
  ])('refuses %s instead of using it', (_label, stored) => {
    expect(parsePasswordHash(stored)).toBeUndefined();
  });
});

describe('session tokens', () => {
  it('are 256 bits of randomness, URL-safe, and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWellFormedSessionToken(token)).toBe(true);
    }
  });

  it('are stored only as a SHA-256 hash that is not the token and is stable', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(generateSessionToken()));
  });

  it('are shape-checked before any lookup', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, 'a b'.repeat(15)])
      expect(isWellFormedSessionToken(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('session expiry rules', () => {
  const t0 = new Date('2026-03-01T12:00:00.000Z');
  const hour = 60 * 60_000;
  const session = (change: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 's',
    userId: 'u',
    tokenHash: 'h',
    createdAt: t0,
    lastSeenAt: t0,
    idleExpiresAt: new Date(t0.getTime() + hour),
    absoluteExpiresAt: new Date(t0.getTime() + 24 * hour),
    revokedAt: null,
    userAgent: null,
    ...change,
  });
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('is usable until it is revoked or reaches either expiry (the boundary itself is expired)', () => {
    expect(rejectionOf(session(), at(0))).toBeNull();
    expect(rejectionOf(session(), at(hour - 1))).toBeNull();
    expect(rejectionOf(session(), at(hour))).toBe('expired_idle');
    expect(rejectionOf(session({ idleExpiresAt: at(30 * hour) }), at(24 * hour))).toBe('expired_absolute');
    expect(rejectionOf(session({ revokedAt: at(1) }), at(2))).toBe('revoked');
  });

  it('writes its last-seen time at most once a minute', () => {
    expect(shouldTouch(session(), at(TOUCH_INTERVAL_MS - 1))).toBe(false);
    expect(shouldTouch(session(), at(TOUCH_INTERVAL_MS))).toBe(true);
  });

  it('slides the idle expiry forward on use, but never past the absolute expiry', () => {
    const absolute = at(24 * hour);
    expect(slideIdleExpiry(at(5 * hour), hour, absolute)).toEqual(at(6 * hour));
    expect(slideIdleExpiry(at(23.5 * hour), hour, absolute)).toEqual(absolute);
  });

  it('starts a new session with both expiries from the time of sign-in', () => {
    expect(expiryTimes(t0, hour, 24 * hour)).toEqual({
      idleExpiresAt: at(hour),
      absoluteExpiresAt: at(24 * hour),
    });
    // An idle lifetime longer than the absolute one is capped by it.
    expect(expiryTimes(t0, 48 * hour, 24 * hour).idleExpiresAt).toEqual(at(24 * hour));
  });
});
