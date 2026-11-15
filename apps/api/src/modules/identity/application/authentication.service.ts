import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoginRequest } from '@agentos/contracts';
import { AuditRecorder } from '../../audit';
import { TransactionRunner } from '../../database';
import type { SessionRecord } from '../domain/session';
import type { UserRecord } from '../domain/user';
import { invalidCredentials } from './errors';
import {
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  THROTTLE,
  USER_REPOSITORY,
  type ClientContext,
  type PasswordHasher,
  type SessionRepository,
  type Throttle,
  type UserRepository,
} from './ports';
import { SessionService } from './session.service';

export interface SignedIn {
  readonly user: UserRecord;
  readonly session: SessionRecord;
  /** The token in clear. It exists only here and in the response; the database keeps its hash. */
  readonly token: string;
}

/**
 * Sign-in with email and password (ADR-0010, decisions 2 and 3).
 *
 * Failure behavior is deliberately uniform: an unknown email, a wrong password, a disabled account and an unusable stored hash all
 * end in the same `invalid_credentials` error, after a real (or dummy) hash verification, so neither the response nor its timing
 * says which one happened.
 */
@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger(AuthenticationService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(THROTTLE) private readonly throttle: Throttle,
    private readonly sessionService: SessionService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  async login(input: Required<LoginRequest>, client: ClientContext): Promise<SignedIn> {
    const delivery = input.delivery ?? 'cookie';

    // 1. Budgets first, before any expensive work. Fails closed (503) if the limiter is unavailable; 429 when exhausted.
    await this.throttle.ensureWithinLimit('signin-account', input.email);
    await this.throttle.ensureWithinLimit('signin-address', client.address);

    // 2. Verify. Every path that does not succeed spends the same kind of time and ends in the same error.
    const user = await this.users.findByEmail(input.email);
    const storedHash = user && user.status === 'active' ? await this.users.findPasswordHash(user.id) : null;
    if (!user || !storedHash) {
      await this.hasher.verifyDummy(input.password);
      await this.failed(input.email, client, null);
      throw invalidCredentials();
    }
    const verification = await this.hasher.verify(input.password, storedHash);
    if (!verification.valid) {
      await this.failed(input.email, client, user);
      throw invalidCredentials();
    }

    // 3. Success: the session, an upgraded hash if the policy moved on, and the audit record commit together.
    const upgradedHash = verification.needsRehash ? await this.hasher.hash(input.password) : null; // hashing stays outside the transaction
    const prepared = this.sessionService.prepareNew(user.id, client.userAgent);
    const session = await this.transactions.run(async (tx) => {
      if (upgradedHash) await this.users.updatePasswordHash(user.id, upgradedHash, tx);
      const created = await this.sessions.create(prepared.session, tx);
      await this.audit.record(
        {
          action: 'auth.login_succeeded',
          resourceType: 'session',
          result: 'success',
          actorUserId: user.id,
          resourceId: created.id,
          metadata: { delivery },
        },
        tx,
      );
      return created;
    });

    // The account has proven itself: forgive its earlier failures. A counter that cannot be reset must not fail a valid sign-in.
    await this.throttle.reset('signin-account', input.email).catch(() => {
      this.logger.warn('Could not reset the sign-in failure counter (the rate limiter is unavailable)');
    });
    return { user, session, token: prepared.token };
  }

  /**
   * Counts a failed attempt and records it. The audit record is written only for an EXISTING account (an attacker must not be able to
   * grow the table with invented addresses) and in its own transaction: there is no business change to commit it with. A failure to
   * write it is logged and does not change the response.
   */
  private async failed(email: string, client: ClientContext, user: UserRecord | null): Promise<void> {
    const account = await this.throttle.hit('signin-account', email);
    const address = await this.throttle.hit('signin-address', client.address);
    if (!user) {
      this.logger.warn('Sign-in failed for an unknown account'); // no address or email in the log line
      return;
    }
    try {
      await this.transactions.run(async (tx) => {
        const common = {
          resourceType: 'user' as const,
          result: 'failure' as const,
          actorUserId: user.id,
          resourceId: user.id,
        };
        await this.audit.record({ action: 'auth.login_failed', ...common, metadata: {} }, tx);
        if (account.exhausted)
          await this.audit.record(
            { action: 'auth.login_throttled', ...common, metadata: { scope: 'account' } },
            tx,
          );
        if (address.exhausted)
          await this.audit.record(
            { action: 'auth.login_throttled', ...common, metadata: { scope: 'address' } },
            tx,
          );
      });
    } catch (error) {
      this.logger.error(
        `Could not record a failed sign-in in the audit trail (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }
}
