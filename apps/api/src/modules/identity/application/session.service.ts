import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../database';
import { AuditRecorder } from '../../audit';
import {
  expiryTimes,
  rejectionOf,
  shouldTouch,
  slideIdleExpiry,
  type SessionRecord,
} from '../domain/session';
import { generateSessionToken, hashSessionToken, isWellFormedSessionToken } from '../domain/session-token';
import type { Principal, UserRecord } from '../domain/user';
import {
  CLOCK,
  IDENTITY_SETTINGS,
  SESSION_REPOSITORY,
  type Clock,
  type IdentitySettings,
  type NewSession,
  type SessionRepository,
} from './ports';

export interface AuthenticatedSession {
  readonly principal: Principal;
  readonly user: UserRecord;
  readonly session: SessionRecord;
}

/**
 * Server-side sessions: creation, validation, expiry and revocation. Validation reads PostgreSQL only: it never touches Redis,
 * so an outage of the rate limiter does not log anyone out (ADR-0010, decision 2).
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  /** What a new session of this user looks like, plus the token to hand to the client (the only moment the token exists in clear). */
  prepareNew(userId: string, userAgent: string | null): { token: string; session: NewSession } {
    const now = this.clock.now();
    const token = generateSessionToken();
    return {
      token,
      session: {
        userId,
        tokenHash: hashSessionToken(token),
        userAgent: userAgent?.slice(0, 255) ?? null,
        now,
        ...expiryTimes(now, this.settings.idleTtlMs, this.settings.absoluteTtlMs),
      },
    };
  }

  /**
   * The session a presented token belongs to, or `null`. Malformed, unknown, revoked and expired tokens and tokens of disabled users
   * all give the same `null`; the caller answers one generic 401.
   */
  async resolve(token: string): Promise<AuthenticatedSession | null> {
    if (!isWellFormedSessionToken(token)) return null;
    const found = await this.sessions.findByTokenHash(hashSessionToken(token));
    if (!found) return null;
    const now = this.clock.now();
    if (rejectionOf(found.session, now) !== null) return null;
    if (found.user.status !== 'active') return null;

    // Sliding idle expiry, written at most once a minute so that reading a session is not a write every time.
    let session = found.session;
    if (shouldTouch(session, now)) {
      const idleExpiresAt = slideIdleExpiry(now, this.settings.idleTtlMs, session.absoluteExpiresAt);
      await this.sessions.touch(session.id, now, idleExpiresAt);
      session = { ...session, lastSeenAt: now, idleExpiresAt };
    }
    return { principal: { userId: session.userId, sessionId: session.id }, user: found.user, session };
  }

  /** Ends the caller's own session. */
  async logout(principal: Principal): Promise<void> {
    await this.transactions.run(async (tx) => {
      const revoked = await this.sessions.revoke(principal.sessionId, this.clock.now(), tx);
      if (revoked) {
        await this.audit.record(
          {
            action: 'auth.logout',
            resourceType: 'session',
            result: 'success',
            actorUserId: principal.userId,
            resourceId: principal.sessionId,
            metadata: {},
          },
          tx,
        );
      }
    });
  }

  /** Ends every session of the caller, this one included. */
  async logoutAll(principal: Principal): Promise<number> {
    return this.transactions.run(async (tx) => {
      const revokedSessions = await this.sessions.revokeAllForUser(principal.userId, this.clock.now(), tx);
      await this.audit.record(
        {
          action: 'auth.logout_all',
          resourceType: 'user',
          result: 'success',
          actorUserId: principal.userId,
          resourceId: principal.userId,
          metadata: { revokedSessions },
        },
        tx,
      );
      return revokedSessions;
    });
  }
}
