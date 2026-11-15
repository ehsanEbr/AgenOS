import { createHash, randomBytes } from 'node:crypto';

/** 256 bits from the operating system's CSPRNG, URL-safe (43 characters). Opaque: it carries no information. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores instead of the token: SHA-256, hex. A fast hash is correct here (unlike for passwords) because the token
 * is 256 bits of randomness, so there is nothing to brute-force; a database leak does not yield usable tokens.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check done before any lookup, so garbage never reaches the database. */
export function isWellFormedSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
