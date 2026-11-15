import { randomUUID } from 'node:crypto';
import type { AuditEventInput } from '@agentos/contracts';
import { AppError } from '../../src/common/app-error';
import type {
  Clock,
  IdentitySettings,
  NewSession,
  NewUser,
  PasswordHasher,
  SessionRepository,
  SessionWithUser,
  Throttle,
  UserRepository,
} from '../../src/modules/identity/application/ports';
import type { SessionRecord } from '../../src/modules/identity/domain/session';
import { THROTTLE_RULES, type ThrottleScope } from '../../src/modules/identity/domain/throttle-policy';
import type { UserRecord } from '../../src/modules/identity/domain/user';

/*
 * In-memory stand-ins for the Identity ports, so the application services can be tested without a database, Redis or the real
 * (deliberately slow) password hash. Behavior against the REAL PostgreSQL, Redis and scrypt belongs in *.int.spec.ts.
 */

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-03-01T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const SETTINGS: IdentitySettings = {
  allowRegistration: false,
  idleTtlMs: 60 * 60_000, // 1 h
  absoluteTtlMs: 24 * 60 * 60_000, // 24 h
  webOrigin: 'http://localhost:5173',
  secureCookies: false,
  cookieName: 'agentos_session',
};

/** Runs the callback immediately with a placeholder handle (the fakes ignore it). No rollback is simulated. */
export class FakeTransactions {
  run<T>(fn: (tx: never) => Promise<T>): Promise<T> {
    return fn({} as never);
  }
}

export class FakeAudit {
  readonly events: AuditEventInput[] = [];
  /** Set to make `record` fail, to prove a failure to audit is handled as specified. */
  failWith?: Error;
  record(event: AuditEventInput): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.events.push(event);
    return Promise.resolve();
  }
  actions(): string[] {
    return this.events.map((event) => event.action);
  }
}

export class InMemoryUsers implements UserRepository {
  readonly users: UserRecord[] = [];
  readonly hashes = new Map<string, string>();
  lockCalls = 0;

  add(input: Partial<UserRecord> & { email: string }, passwordHash = 'hash(pw)'): UserRecord {
    const user: UserRecord = {
      id: randomUUID(),
      displayName: 'Someone',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...input,
    };
    this.users.push(user);
    this.hashes.set(user.id, passwordHash);
    return user;
  }
  findByEmail(email: string) {
    return Promise.resolve(this.users.find((u) => u.email === email) ?? null);
  }
  findById(id: string) {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }
  findByIds(ids: readonly string[]) {
    return Promise.resolve(this.users.filter((u) => ids.includes(u.id)));
  }
  hasAnyUser() {
    return Promise.resolve(this.users.length > 0);
  }
  lockRegistration() {
    this.lockCalls += 1;
    return Promise.resolve();
  }
  create(user: NewUser) {
    if (this.users.some((u) => u.email === user.email))
      return Promise.reject(
        new AppError('conflict', 'email_taken', 'An account with this email already exists'),
      );
    const created: UserRecord = {
      id: randomUUID(),
      email: user.email,
      displayName: user.displayName,
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    this.users.push(created);
    return Promise.resolve(created);
  }
  findPasswordHash(userId: string) {
    return Promise.resolve(this.hashes.get(userId) ?? null);
  }
  createCredential(userId: string, passwordHash: string) {
    this.hashes.set(userId, passwordHash);
    return Promise.resolve();
  }
  updatePasswordHash(userId: string, passwordHash: string) {
    this.hashes.set(userId, passwordHash);
    return Promise.resolve();
  }
}

export class InMemorySessions implements SessionRepository {
  readonly sessions: SessionRecord[] = [];
  touches = 0;

  constructor(private readonly users: InMemoryUsers) {}

  create(session: NewSession) {
    const record: SessionRecord = {
      id: randomUUID(),
      userId: session.userId,
      tokenHash: session.tokenHash,
      createdAt: session.now,
      lastSeenAt: session.now,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      revokedAt: null,
      userAgent: session.userAgent,
    };
    this.sessions.push(record);
    return Promise.resolve(record);
  }
  async findByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
    const session = this.sessions.find((s) => s.tokenHash === tokenHash);
    const user = session && (await this.users.findById(session.userId));
    return session && user ? { session, user } : null;
  }
  touch(id: string, lastSeenAt: Date, idleExpiresAt: Date) {
    this.touches += 1;
    this.replace(id, { lastSeenAt, idleExpiresAt });
    return Promise.resolve();
  }
  revoke(id: string, at: Date) {
    const found = this.sessions.find((s) => s.id === id && s.revokedAt === null);
    if (found) this.replace(id, { revokedAt: at });
    return Promise.resolve(found !== undefined);
  }
  revokeAllForUser(userId: string, at: Date, _db: unknown, exceptSessionId?: string) {
    let count = 0;
    for (const s of this.sessions) {
      if (
        s.userId === userId &&
        s.revokedAt === null &&
        s.id !== exceptSessionId &&
        s.idleExpiresAt > at &&
        s.absoluteExpiresAt > at
      ) {
        this.replace(s.id, { revokedAt: at });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  rotateToken(id: string, newTokenHash: string) {
    this.replace(id, { tokenHash: newTokenHash });
    return Promise.resolve();
  }
  private replace(id: string, change: Partial<SessionRecord>): void {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index !== -1) this.sessions[index] = { ...(this.sessions[index] as SessionRecord), ...change };
  }
}

/** Counts events per scope and subject like the Redis implementation (without windows), and can simulate an unavailable limiter. */
export class FakeThrottle implements Throttle {
  private readonly counts = new Map<string, number>();
  unavailable = false;
  readonly calls: string[] = [];

  ensureWithinLimit(scope: ThrottleScope, subject: string): Promise<void> {
    this.calls.push(`ensure:${scope}`);
    if (this.unavailable) return Promise.reject(unavailableError());
    if ((this.counts.get(`${scope}:${subject}`) ?? 0) >= THROTTLE_RULES[scope].max)
      return Promise.reject(
        new AppError('rate_limited', 'too_many_attempts', 'Too many attempts. Try again later.'),
      );
    return Promise.resolve();
  }
  hit(scope: ThrottleScope, subject: string): Promise<{ exhausted: boolean }> {
    this.calls.push(`hit:${scope}`);
    if (this.unavailable) return Promise.reject(unavailableError());
    const count = (this.counts.get(`${scope}:${subject}`) ?? 0) + 1;
    this.counts.set(`${scope}:${subject}`, count);
    return Promise.resolve({ exhausted: count === THROTTLE_RULES[scope].max });
  }
  reset(scope: ThrottleScope, subject: string): Promise<void> {
    this.calls.push(`reset:${scope}`);
    if (this.unavailable) return Promise.reject(unavailableError());
    this.counts.delete(`${scope}:${subject}`);
    return Promise.resolve();
  }
  countOf(scope: ThrottleScope, subject: string): number {
    return this.counts.get(`${scope}:${subject}`) ?? 0;
  }
}

function unavailableError() {
  return new AppError(
    'unavailable',
    'authentication_unavailable',
    'Authentication is temporarily unavailable',
  );
}

/** `hash(pw)` for password `pw`: reversible on purpose, and instant. Tracks what was asked of it. */
export class FakeHasher implements PasswordHasher {
  readonly hashed: string[] = [];
  readonly verified: string[] = [];
  dummyVerifications = 0;
  /** Makes `verify` report that the stored hash is below the current policy. */
  needsRehash = false;

  hash(password: string) {
    this.hashed.push(password);
    return Promise.resolve(`hash(${password})`);
  }
  verify(password: string, stored: string) {
    this.verified.push(password);
    const valid = stored === `hash(${password})`;
    return Promise.resolve({ valid, needsRehash: valid && this.needsRehash });
  }
  verifyDummy() {
    this.dummyVerifications += 1;
    return Promise.resolve();
  }
}
