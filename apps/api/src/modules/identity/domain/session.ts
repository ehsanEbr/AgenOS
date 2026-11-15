export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  /** Ends the session unless it is used again. */
  readonly idleExpiresAt: Date;
  /** Ends the session regardless of use. */
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly userAgent: string | null;
}

/** Why a session may not be used. Never shown to clients: all of them are the same 401. */
export type SessionRejection = 'revoked' | 'expired_absolute' | 'expired_idle';

export function rejectionOf(session: SessionRecord, now: Date): SessionRejection | null {
  if (session.revokedAt !== null) return 'revoked';
  if (now >= session.absoluteExpiresAt) return 'expired_absolute';
  if (now >= session.idleExpiresAt) return 'expired_idle';
  return null;
}

/** `last_seen_at` and the idle expiry are written at most this often, so reading a session is not a write every time. */
export const TOUCH_INTERVAL_MS = 60_000;

export function shouldTouch(session: SessionRecord, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS;
}

/** Using a session moves its idle expiry forward, but never past the absolute expiry. */
export function slideIdleExpiry(now: Date, idleTtlMs: number, absoluteExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + idleTtlMs, absoluteExpiresAt.getTime()));
}

export function expiryTimes(now: Date, idleTtlMs: number, absoluteTtlMs: number) {
  const absoluteExpiresAt = new Date(now.getTime() + absoluteTtlMs);
  return { idleExpiresAt: slideIdleExpiry(now, idleTtlMs, absoluteExpiresAt), absoluteExpiresAt };
}
