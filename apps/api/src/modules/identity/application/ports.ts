import type { DatabaseClient } from '../../database';
import type { SessionRecord } from '../domain/session';
import type { ThrottleScope } from '../domain/throttle-policy';
import type { UserRecord } from '../domain/user';

/*
 * Ports of the Identity application layer (ADR-0010, decision 1). They live here, not in the domain, because repository methods
 * carry the transaction handle (`DatabaseClient`) and the domain layer may not import the database module.
 * Infrastructure implements them; the application services depend on nothing else.
 */

export interface NewUser {
  readonly email: string;
  readonly displayName: string;
}

export interface UserRepository {
  findByEmail(email: string, db?: DatabaseClient): Promise<UserRecord | null>;
  findById(id: string, db?: DatabaseClient): Promise<UserRecord | null>;
  findByIds(ids: readonly string[], db?: DatabaseClient): Promise<UserRecord[]>;
  hasAnyUser(db?: DatabaseClient): Promise<boolean>;
  /** Serializes registrations until the transaction ends (bootstrap must not race: two "first" users are impossible). */
  lockRegistration(db: DatabaseClient): Promise<void>;
  /** Throws AppError('conflict', 'email_taken') when the address already has an account. */
  create(user: NewUser, db: DatabaseClient): Promise<UserRecord>;
  findPasswordHash(userId: string, db?: DatabaseClient): Promise<string | null>;
  createCredential(userId: string, passwordHash: string, db: DatabaseClient): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string, db: DatabaseClient): Promise<void>;
}

export interface NewSession {
  readonly userId: string;
  readonly tokenHash: string;
  readonly userAgent: string | null;
  readonly now: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface SessionWithUser {
  readonly session: SessionRecord;
  readonly user: UserRecord;
}

export interface SessionRepository {
  create(session: NewSession, db: DatabaseClient): Promise<SessionRecord>;
  /** Returns the session whatever its state (revoked, expired): the service applies the policy. */
  findByTokenHash(tokenHash: string, db?: DatabaseClient): Promise<SessionWithUser | null>;
  touch(id: string, lastSeenAt: Date, idleExpiresAt: Date, db?: DatabaseClient): Promise<void>;
  /** True when the session was active and is now revoked. */
  revoke(id: string, at: Date, db: DatabaseClient): Promise<boolean>;
  /** Revokes every active session of the user (optionally sparing one) and returns how many it revoked. */
  revokeAllForUser(userId: string, at: Date, db: DatabaseClient, exceptSessionId?: string): Promise<number>;
  /** Replaces the token of a session in place: the old token stops working at once, the session keeps its creation time and expiry. */
  rotateToken(id: string, newTokenHash: string, db: DatabaseClient): Promise<void>;
}

/**
 * Rate limiting for the authentication endpoints, backed by ephemeral state. Every method fails CLOSED: if the counters cannot be
 * read or written it throws AppError('unavailable'), so an outage never turns into unlimited attempts.
 */
export interface Throttle {
  /** Throws AppError('rate_limited') with `retryAfterSeconds` when the budget of this subject in this scope is used up. Does not count. */
  ensureWithinLimit(scope: ThrottleScope, subject: string): Promise<void>;
  /** Counts one event. `exhausted` is true for exactly the event that used up the budget (so "limit reached" is recorded once per window). */
  hit(scope: ThrottleScope, subject: string): Promise<{ exhausted: boolean }>;
  reset(scope: ThrottleScope, subject: string): Promise<void>;
}

export interface PasswordHasher {
  /** Hashes a NEW password with the current policy. */
  hash(password: string): Promise<string>;
  /** `valid` is false for a wrong password AND for an unusable stored hash; `needsRehash` is only meaningful when `valid`. */
  verify(password: string, stored: string): Promise<{ valid: boolean; needsRehash: boolean }>;
  /** Spends the time of a real verification, so an unknown account cannot be told from a wrong password by timing. */
  verifyDummy(password: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Everything the Identity services take from configuration, resolved once at startup. */
export interface IdentitySettings {
  readonly allowRegistration: boolean;
  readonly idleTtlMs: number;
  readonly absoluteTtlMs: number;
  /** Where browsers load the web app from: the one origin a cookie-authenticated state-changing request may come from. */
  readonly webOrigin: string;
  readonly secureCookies: boolean;
  readonly cookieName: string;
}

/** What the HTTP layer knows about the caller that the services need (rate limiting, session metadata). */
export interface ClientContext {
  readonly address: string;
  readonly userAgent: string | null;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const THROTTLE = Symbol('THROTTLE');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const CLOCK = Symbol('CLOCK');
export const IDENTITY_SETTINGS = Symbol('IDENTITY_SETTINGS');
