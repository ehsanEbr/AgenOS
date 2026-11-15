import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditRecorder } from '../../audit';
import { TransactionRunner } from '../../database';
import { hashSessionToken, generateSessionToken } from '../domain/session-token';
import type { SessionRecord } from '../domain/session';
import { invalidCredentials, invalidCurrentPassword } from './errors';
import {
  CLOCK,
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  THROTTLE,
  USER_REPOSITORY,
  type Clock,
  type PasswordHasher,
  type SessionRepository,
  type Throttle,
  type UserRepository,
} from './ports';
import type { AuthenticatedSession } from './session.service';

export interface PasswordChanged {
  readonly session: SessionRecord;
  /** The rotated token in clear (only here and in the response). The previous token no longer works. */
  readonly token: string;
}

/** Changes to the signed-in user's own account that touch their credentials. */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(THROTTLE) private readonly throttle: Throttle,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  /**
   * Replaces the password, ends every OTHER session of the user and rotates the token of the current one, all in one transaction
   * (ADR-0010, decision 2: a password change is a security-sensitive change). The session keeps its creation time and expiry; only the
   * token changes, so the old token stops working at once.
   */
  async changePassword(
    caller: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<PasswordChanged> {
    const { userId, sessionId } = caller.principal;

    await this.throttle.ensureWithinLimit('password-account', userId);
    const storedHash = await this.users.findPasswordHash(userId);
    if (!storedHash) throw invalidCredentials(); // an active session without a credential cannot happen; never act on it
    const verification = await this.hasher.verify(currentPassword, storedHash);
    if (!verification.valid) throw await this.failedAttempt(userId);

    const newHash = await this.hasher.hash(newPassword); // hashing stays outside the transaction
    const token = generateSessionToken();
    const session = await this.transactions.run(async (tx) => {
      await this.users.updatePasswordHash(userId, newHash, tx);
      const revokedOtherSessions = await this.sessions.revokeAllForUser(
        userId,
        this.clock.now(),
        tx,
        sessionId,
      );
      await this.sessions.rotateToken(sessionId, hashSessionToken(token), tx);
      await this.audit.record(
        {
          action: 'auth.password_changed',
          resourceType: 'user',
          result: 'success',
          actorUserId: userId,
          resourceId: userId,
          metadata: { revokedOtherSessions },
        },
        tx,
      );
      return caller.session;
    });

    await this.throttle.reset('password-account', userId).catch(() => {
      this.logger.warn(
        'Could not reset the password-change failure counter (the rate limiter is unavailable)',
      );
    });
    return { session, token };
  }

  /**
   * Counts a failed "current password" check, records it, and returns the error to throw.
   *
   * The audit record follows the failed sign-in convention: its own short transaction (there is no change to commit it with), and a
   * failure to write it is logged without changing the response. `exhausted` is true for exactly the failure that used the budget up,
   * so "rate limit reached" is recorded once per window; the 429 that follows is not recorded again. Nothing secret is in the event.
   * If the limiter itself is unavailable the attempt is still recorded and the caller still gets the fail-closed 503.
   */
  private async failedAttempt(userId: string): Promise<unknown> {
    let exhausted = false;
    let limiterFailure: unknown;
    try {
      exhausted = (await this.throttle.hit('password-account', userId)).exhausted;
    } catch (error) {
      limiterFailure = error;
    }

    try {
      await this.transactions.run(async (tx) => {
        const common = {
          resourceType: 'user' as const,
          result: 'failure' as const,
          actorUserId: userId,
          resourceId: userId,
        };
        await this.audit.record(
          {
            action: 'auth.password_change_failed',
            ...common,
            metadata: { reason: 'wrong_current_password' },
          },
          tx,
        );
        if (exhausted)
          await this.audit.record(
            { action: 'auth.password_change_failed', ...common, metadata: { reason: 'rate_limited' } },
            tx,
          );
      });
    } catch (error) {
      this.logger.error(
        `Could not record a failed password change in the audit trail (${error instanceof Error ? error.name : 'error'})`,
      );
    }

    return limiterFailure ?? invalidCurrentPassword();
  }
}
