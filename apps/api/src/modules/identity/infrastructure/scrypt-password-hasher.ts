import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { authenticationUnavailable } from '../application/errors';
import type { PasswordHasher } from '../application/ports';
import {
  type PasswordHashParts,
  formatPasswordHash,
  needsRehash,
  parsePasswordHash,
} from '../domain/password-hash';
import { PASSWORD_HASH_POLICY } from '../domain/password-policy';
import { Semaphore } from './semaphore';

export interface ScryptParameters {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
}

/** The key derivation, injectable so tests can observe concurrency without paying 128 MiB per call. */
export type DeriveKey = (
  password: Buffer,
  salt: Buffer,
  keyLength: number,
  parameters: ScryptParameters,
) => Promise<Buffer>;

const deriveWithNodeScrypt: DeriveKey = (password, salt, keyLength, parameters) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, parameters, (error, key) => (error ? reject(error) : resolve(key)));
  });

/**
 * Password hashing with the approved scrypt policy (ADR-0010, decision 3):
 * N = 2^17, r = 8, p = 1, 32-byte key, 16-byte random salt, an explicit 256 MiB `maxmem`, at most two hashes at once per process.
 *
 * Passwords are NFKC-normalized before hashing, so the same password typed in a different but canonically equivalent form matches.
 * Neither passwords nor hashes are ever logged.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  private readonly logger = new Logger(ScryptPasswordHasher.name);
  private readonly slots = new Semaphore(PASSWORD_HASH_POLICY.maxConcurrentHashes);
  /** A well-formed hash of a password nobody knows, made WITHOUT running scrypt, used to equalize the time of unknown accounts. */
  private readonly dummy: string;

  constructor(private readonly derive: DeriveKey = deriveWithNodeScrypt) {
    this.dummy = formatPasswordHash({
      version: PASSWORD_HASH_POLICY.version,
      costLog2: PASSWORD_HASH_POLICY.costLog2,
      blockSize: PASSWORD_HASH_POLICY.blockSize,
      parallelization: PASSWORD_HASH_POLICY.parallelization,
      keyLength: PASSWORD_HASH_POLICY.keyLength,
      salt: randomBytes(PASSWORD_HASH_POLICY.saltLength),
      hash: randomBytes(PASSWORD_HASH_POLICY.keyLength),
    });
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_HASH_POLICY.saltLength);
    const key = await this.derived(password, salt, {
      costLog2: PASSWORD_HASH_POLICY.costLog2,
      blockSize: PASSWORD_HASH_POLICY.blockSize,
      parallelization: PASSWORD_HASH_POLICY.parallelization,
      keyLength: PASSWORD_HASH_POLICY.keyLength,
    });
    return formatPasswordHash({
      version: PASSWORD_HASH_POLICY.version,
      costLog2: PASSWORD_HASH_POLICY.costLog2,
      blockSize: PASSWORD_HASH_POLICY.blockSize,
      parallelization: PASSWORD_HASH_POLICY.parallelization,
      keyLength: PASSWORD_HASH_POLICY.keyLength,
      salt,
      hash: key,
    });
  }

  async verify(password: string, stored: string): Promise<{ valid: boolean; needsRehash: boolean }> {
    const parts = parsePasswordHash(stored);
    if (!parts) {
      // Not a hash this policy can use (unknown version, parameters outside the accepted range, damaged). Log THAT, never the value,
      // and still spend a real verification so it cannot be told apart by timing.
      this.logger.error(
        'A stored password hash is unusable (format, version or parameters); the sign-in is refused',
      );
      await this.verify(password, this.dummy);
      return { valid: false, needsRehash: false };
    }
    const key = await this.derived(password, parts.salt, parts);
    const valid = key.length === parts.hash.length && timingSafeEqual(key, parts.hash);
    return { valid, needsRehash: valid && needsRehash(parts) };
  }

  async verifyDummy(password: string): Promise<void> {
    await this.verify(password, this.dummy);
  }

  private async derived(
    password: string,
    salt: Buffer,
    parameters: Pick<PasswordHashParts, 'costLog2' | 'blockSize' | 'parallelization' | 'keyLength'>,
  ): Promise<Buffer> {
    const release = await this.slots.acquire(PASSWORD_HASH_POLICY.slotWaitMs, () =>
      authenticationUnavailable(5),
    );
    try {
      return await this.derive(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, parameters.keyLength, {
        N: 2 ** parameters.costLog2,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: PASSWORD_HASH_POLICY.maxMemoryBytes,
      });
    } finally {
      release();
    }
  }
}
