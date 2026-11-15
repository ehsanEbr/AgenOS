import { Inject, Injectable } from '@nestjs/common';
import type { RegisterRequest } from '@agentos/contracts';
import { AuditRecorder } from '../../audit';
import { TransactionRunner } from '../../database';
import type { UserRecord } from '../domain/user';
import { registrationClosed } from './errors';
import {
  IDENTITY_SETTINGS,
  PASSWORD_HASHER,
  THROTTLE,
  USER_REPOSITORY,
  type ClientContext,
  type IdentitySettings,
  type PasswordHasher,
  type Throttle,
  type UserRepository,
} from './ports';

/**
 * Registration and instance bootstrap (ADR-0010, decision 2).
 *
 * - On an EMPTY instance the first registration is always allowed (bootstrap). After that, registration is closed unless the
 *   operator set AUTH_ALLOW_REGISTRATION=true (read at startup).
 * - Bootstrap is safe against concurrent requests: the decision and the insert happen in one transaction that first takes a
 *   transaction-level advisory lock, so two simultaneous first registrations cannot both be "the first".
 * - Registration creates a user and nothing else. The first organization is created later, through the organizations API.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(THROTTLE) private readonly throttle: Throttle,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  async register(input: RegisterRequest, client: ClientContext): Promise<UserRecord> {
    // Fails closed (503) if the limiter is unavailable; 429 when this address has registered too often.
    await this.throttle.ensureWithinLimit('register-address', client.address);
    await this.throttle.hit('register-address', client.address);

    // Cheap early refusal: a closed instance must not spend 128 MiB and a quarter second of CPU hashing a password it will reject.
    // The authoritative decision is repeated below under the lock.
    if (!this.settings.allowRegistration && (await this.users.hasAnyUser())) throw registrationClosed();

    const passwordHash = await this.hasher.hash(input.password); // before the transaction: never hold a lock while hashing

    return this.transactions.run(async (tx) => {
      await this.users.lockRegistration(tx);
      const bootstrap = !(await this.users.hasAnyUser(tx));
      if (!bootstrap && !this.settings.allowRegistration) throw registrationClosed();

      const user = await this.users.create({ email: input.email, displayName: input.displayName }, tx);
      await this.users.createCredential(user.id, passwordHash, tx);
      await this.audit.record(
        {
          action: 'auth.registered',
          resourceType: 'user',
          result: 'success',
          actorUserId: user.id,
          resourceId: user.id,
          metadata: { bootstrap },
        },
        tx,
      );
      return user;
    });
  }
}
