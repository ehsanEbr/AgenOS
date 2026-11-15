import { PASSWORD_HASH_ACCEPTED, PASSWORD_HASH_POLICY } from './password-policy';

/**
 * The stored form of a password: one versioned string that carries its own cost parameters,
 *
 *   $scrypt$v=1$ln=17,r=8,p=1,len=32$<salt>$<hash>        (salt and hash: unpadded base64url)
 *
 * so a stored hash can always be verified with the parameters it was made with, and moved to a stronger policy later.
 */
export interface PasswordHashParts {
  readonly version: number;
  readonly costLog2: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly keyLength: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

export function formatPasswordHash(parts: PasswordHashParts): string {
  return [
    '',
    'scrypt',
    `v=${parts.version}`,
    `ln=${parts.costLog2},r=${parts.blockSize},p=${parts.parallelization},len=${parts.keyLength}`,
    parts.salt.toString('base64url'),
    parts.hash.toString('base64url'),
  ].join('$');
}

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

/**
 * Parses a stored hash. Returns `undefined` for anything that is not a well-formed hash of a known version with parameters inside
 * the accepted ranges; the caller treats that as "the password does not match" and logs the version only, never the string.
 */
export function parsePasswordHash(stored: string): PasswordHashParts | undefined {
  const fields = stored.split('$');
  // ['', 'scrypt', 'v=1', 'ln=17,r=8,p=1,len=32', salt, hash]
  if (fields.length !== 6 || fields[0] !== '' || fields[1] !== 'scrypt') return undefined;
  const version = /^v=(\d+)$/.exec(fields[2] ?? '')?.[1];
  const parameters = /^ln=(\d+),r=(\d+),p=(\d+),len=(\d+)$/.exec(fields[3] ?? '');
  if (version === undefined || !parameters) return undefined;
  if (Number(version) !== PASSWORD_HASH_POLICY.version) return undefined; // an unknown version is not guessed at
  const [costLog2, blockSize, parallelization, keyLength] = parameters.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (
    !inRange(costLog2, PASSWORD_HASH_ACCEPTED.costLog2) ||
    !inRange(blockSize, PASSWORD_HASH_ACCEPTED.blockSize) ||
    !inRange(parallelization, PASSWORD_HASH_ACCEPTED.parallelization) ||
    !inRange(keyLength, PASSWORD_HASH_ACCEPTED.keyLength)
  )
    return undefined;
  const salt = fromBase64Url(fields[4] ?? '');
  const hash = fromBase64Url(fields[5] ?? '');
  if (!salt || !hash || !inRange(salt.length, PASSWORD_HASH_ACCEPTED.saltLength) || hash.length !== keyLength)
    return undefined;
  return { version: Number(version), costLog2, blockSize, parallelization, keyLength, salt, hash };
}

/** True when a successful sign-in should replace the stored hash: it was made with other parameters than the current policy. */
export function needsRehash(parts: PasswordHashParts): boolean {
  return (
    parts.version !== PASSWORD_HASH_POLICY.version ||
    parts.costLog2 !== PASSWORD_HASH_POLICY.costLog2 ||
    parts.blockSize !== PASSWORD_HASH_POLICY.blockSize ||
    parts.parallelization !== PASSWORD_HASH_POLICY.parallelization ||
    parts.keyLength !== PASSWORD_HASH_POLICY.keyLength ||
    parts.salt.length !== PASSWORD_HASH_POLICY.saltLength
  );
}

function fromBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  // Re-encoding must give the same text, so non-canonical encodings are refused.
  return bytes.toString('base64url') === value ? bytes : undefined;
}
