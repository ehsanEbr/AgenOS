/**
 * The approved password hashing policy (ADR-0010, decision 3). These values are PINNED by a unit test: changing any of them fails CI
 * and needs a deliberate edit with review (and an ADR amendment for anything that lowers the cost), so they cannot be weakened
 * silently. Memory pressure is answered by queueing and scaling, never by weaker hashing.
 */
export const PASSWORD_HASH_POLICY = {
  /** Version of this policy; stored in every hash so a later policy can be introduced next to it. */
  version: 1,
  /** scrypt cost N = 2^costLog2 (131072). Needs 128 * N * r bytes = 128 MiB per hash. */
  costLog2: 17,
  /** scrypt block size r. */
  blockSize: 8,
  /** scrypt parallelization p. */
  parallelization: 1,
  /** Derived key length in bytes. */
  keyLength: 32,
  /** Random salt per password, in bytes. */
  saltLength: 16,
  /** Hard ceiling for one hash: twice what the cost needs. A limit, not a reservation. Node's default (32 MiB) would reject N = 2^17. */
  maxMemoryBytes: 256 * 1024 * 1024,
  /** Hashes running at once PER API PROCESS (not global). With R replicas the worst case is 2 x R hashes, about R x 256 MiB. */
  maxConcurrentHashes: 2,
  /** How long a hash waits for a free slot before the request is answered 503. */
  slotWaitMs: 5_000,
} as const;

/**
 * Parameters read back from STORAGE are checked against these ranges before being used: a corrupted or tampered row must not be able
 * to make the process allocate gigabytes. The upper cost bound is the largest N that fits in `maxMemoryBytes` (N = 2^18 would need
 * exactly 256 MiB and Node requires strictly more), so raising the cost later also means raising the memory ceiling.
 */
export const PASSWORD_HASH_ACCEPTED = {
  costLog2: { min: 14, max: 17 },
  blockSize: { min: 8, max: 8 },
  parallelization: { min: 1, max: 4 },
  keyLength: { min: 32, max: 32 },
  saltLength: { min: 16, max: 64 },
} as const;
