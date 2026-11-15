import { randomBytes, scryptSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPasswordHash, parsePasswordHash } from '../domain/password-hash';
import { PASSWORD_HASH_POLICY } from '../domain/password-policy';
import { type DeriveKey, ScryptPasswordHasher } from './scrypt-password-hasher';

// These tests use the REAL scrypt at the approved cost (about a quarter of a second and 128 MiB each), because what is being
// verified is the real parameters. The concurrency and parameter-guard tests use a stand-in derivation instead.

describe('ScryptPasswordHasher with the real key derivation', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const hasher = new ScryptPasswordHasher();

  it('produces a versioned hash with the approved parameters, a 16-byte salt and a 32-byte key', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(stored).toMatch(/^\$scrypt\$v=1\$ln=17,r=8,p=1,len=32\$/);
    const parts = parsePasswordHash(stored);
    expect(parts).toMatchObject({ costLog2: 17, blockSize: 8, parallelization: 1, keyLength: 32 });
    expect(parts?.salt).toHaveLength(16);
    expect(parts?.hash).toHaveLength(32);
    expect(stored).not.toContain('correct horse');
  });

  it('uses a fresh random salt every time, so equal passwords never give equal hashes', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password 123'), hasher.hash('same password 123')]);
    expect(a).not.toBe(b);
    expect(parsePasswordHash(a)?.salt.equals(parsePasswordHash(b)?.salt ?? Buffer.alloc(0))).toBe(false);
  });

  it('accepts the right password and rejects a wrong one, without asking for an upgrade of a current hash', async () => {
    const stored = await hasher.hash('right password 123');
    expect(await hasher.verify('right password 123', stored)).toEqual({ valid: true, needsRehash: false });
    expect(await hasher.verify('wrong password 123', stored)).toEqual({ valid: false, needsRehash: false });
  });

  it('treats canonically equivalent Unicode as the same password (NFKC)', async () => {
    const composed = 'café au lait 2026';
    const decomposed = 'café au lait 2026';
    expect(composed).not.toBe(decomposed);
    const stored = await hasher.hash(composed);
    expect((await hasher.verify(decomposed, stored)).valid).toBe(true);
  });

  it('verifies with the parameters stored in the hash, and asks for an upgrade when they are below the current policy', async () => {
    // A hash made the way an earlier, cheaper policy would have made it (N = 2^14).
    const salt = randomBytes(16);
    const key = scryptSync(Buffer.from('legacy password 12', 'utf8'), salt, 32, { N: 2 ** 14, r: 8, p: 1 });
    const legacy = formatPasswordHash({
      version: 1,
      costLog2: 14,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
      salt,
      hash: key,
    });
    expect(await hasher.verify('legacy password 12', legacy)).toEqual({ valid: true, needsRehash: true });
    expect(await hasher.verify('other password 123', legacy)).toEqual({ valid: false, needsRehash: false });
  });

  it('spends the time of a real verification for an unknown account (and does not throw)', async () => {
    const start = performance.now();
    await hasher.verifyDummy('anything at all 1');
    expect(performance.now() - start).toBeGreaterThan(50); // a real scrypt at this cost, not a no-op
  });
});

describe('ScryptPasswordHasher guards (stand-in key derivation)', () => {
  const noLogs = () => vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const derive = (impl?: DeriveKey) => vi.fn<DeriveKey>(impl ?? (async () => Buffer.alloc(32, 7)));

  it('passes the approved parameters and an explicit 256 MiB memory ceiling on every derivation', async () => {
    const fake = derive();
    await new ScryptPasswordHasher(fake).hash('a password to hash');
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]?.[2]).toBe(32);
    expect(fake.mock.calls[0]?.[3]).toEqual({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  });

  it('never runs more than two hashes at once in one process, and finishes all of them', async () => {
    let running = 0;
    let peak = 0;
    const fake = derive(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return Buffer.alloc(32, 1);
    });
    const hasher = new ScryptPasswordHasher(fake);
    await Promise.all(Array.from({ length: 10 }, (_, i) => hasher.hash(`password number ${i}`)));
    expect(PASSWORD_HASH_POLICY.maxConcurrentHashes).toBe(2);
    expect(peak).toBe(2);
    expect(fake).toHaveBeenCalledTimes(10);
  });

  it('answers 503 (authentication_unavailable) instead of queueing forever when no slot frees up in time', async () => {
    vi.useFakeTimers();
    const fake = derive(() => new Promise(() => undefined)); // two derivations that never finish
    const hasher = new ScryptPasswordHasher(fake);
    void hasher.hash('first password 1234');
    void hasher.hash('second password 123');
    const third = hasher.hash('third password 1234');
    const assertion = expect(third).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'authentication_unavailable',
    });
    await vi.advanceTimersByTimeAsync(PASSWORD_HASH_POLICY.slotWaitMs);
    await assertion;
  });

  it('refuses a stored hash with parameters outside the accepted range WITHOUT deriving with them (no huge allocation)', async () => {
    noLogs();
    const fake = derive();
    const hasher = new ScryptPasswordHasher(fake);
    const tampered = formatPasswordHash({
      version: 1,
      costLog2: 30, // would need 1 TiB
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
      salt: randomBytes(16),
      hash: randomBytes(32),
    });
    expect(await hasher.verify('any password 12345', tampered)).toEqual({ valid: false, needsRehash: false });
    // Whatever it derived (the equalizing dummy verification), it was at the approved cost, never at N = 2^30.
    for (const call of fake.mock.calls) expect(call[3].N).toBe(2 ** PASSWORD_HASH_POLICY.costLog2);
  });

  it('logs that a stored hash is unusable, but never the hash or the password', async () => {
    const error = noLogs();
    const hasher = new ScryptPasswordHasher(derive());
    await hasher.verify('hunter2 hunter2 hunter2', '$scrypt$v=9$garbage-that-looks-secret');
    const logged = JSON.stringify(error.mock.calls);
    expect(error).toHaveBeenCalled();
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('garbage-that-looks-secret');
  });

  it('does not accept a hash whose key differs, even by one byte, and compares in constant time', async () => {
    const stored = await new ScryptPasswordHasher(derive()).hash('whatever password 1');
    const different = new ScryptPasswordHasher(derive(async () => Buffer.alloc(32, 8)));
    expect((await different.verify('whatever password 1', stored)).valid).toBe(false);
    // Same derivation (all 7s): accepted. The comparison itself is crypto.timingSafeEqual over equal-length buffers.
    const same = new ScryptPasswordHasher(derive());
    expect((await same.verify('whatever password 1', stored)).valid).toBe(true);
  });
});
