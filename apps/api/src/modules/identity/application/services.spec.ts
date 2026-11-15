import { Logger } from '@nestjs/common';
import { AppError } from '../../../common/app-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecorder } from '../../audit';
import type { TransactionRunner } from '../../database';
import {
  FakeAudit,
  FakeClock,
  FakeHasher,
  FakeThrottle,
  FakeTransactions,
  InMemorySessions,
  InMemoryUsers,
  SETTINGS,
} from '../../../../test/support/identity-fakes';
import { hashSessionToken } from '../domain/session-token';
import { THROTTLE_RULES } from '../domain/throttle-policy';
import { AccountService } from './account.service';
import { AuthenticationService } from './authentication.service';
import type { IdentitySettings } from './ports';
import { RegistrationService } from './registration.service';
import { SessionService } from './session.service';

const client = { address: '203.0.113.7', userAgent: 'test-agent' };

function build(settings: IdentitySettings = SETTINGS) {
  const users = new InMemoryUsers();
  const sessionsRepo = new InMemorySessions(users);
  const hasher = new FakeHasher();
  const throttle = new FakeThrottle();
  const clock = new FakeClock();
  const audit = new FakeAudit();
  const transactions = new FakeTransactions() as unknown as TransactionRunner;
  const auditRecorder = audit as unknown as AuditRecorder;
  const sessions = new SessionService(sessionsRepo, clock, settings, transactions, auditRecorder);
  return {
    users,
    sessionsRepo,
    hasher,
    throttle,
    clock,
    audit,
    sessions,
    registration: new RegistrationService(users, hasher, throttle, settings, transactions, auditRecorder),
    authentication: new AuthenticationService(
      users,
      sessionsRepo,
      hasher,
      throttle,
      sessions,
      transactions,
      auditRecorder,
    ),
    account: new AccountService(users, sessionsRepo, hasher, throttle, clock, transactions, auditRecorder),
  };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('registration and bootstrap', () => {
  const input = { email: 'first@example.com', displayName: 'First', password: 'a long enough password' };

  it('lets the first user of an empty instance register even though registration is closed, and audits it as the bootstrap', async () => {
    const { registration, users, audit } = build();
    const user = await registration.register(input, client);
    expect(user).toMatchObject({ email: 'first@example.com', status: 'active' });
    expect(users.hashes.get(user.id)).toBe('hash(a long enough password)');
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'auth.registered',
        metadata: { bootstrap: true },
        actorUserId: user.id,
      }),
    ]);
  });

  it('serializes the decision with the lock, so two simultaneous first registrations cannot both bootstrap', async () => {
    const { registration, users } = build();
    await registration.register(input, client);
    expect(users.lockCalls).toBe(1);
  });

  it('closes registration after the first user: 403 registration_closed, no hashing wasted, no account created', async () => {
    const { registration, users, hasher } = build();
    await registration.register(input, client);
    hasher.hashed.length = 0;
    await expect(
      registration.register({ ...input, email: 'second@example.com' }, client),
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'registration_closed' });
    expect(users.users).toHaveLength(1);
    expect(hasher.hashed).toEqual([]); // refused before the expensive hash
  });

  it('accepts further registrations only when the operator enabled them, and records that they are not a bootstrap', async () => {
    const { registration, audit } = build({ ...SETTINGS, allowRegistration: true });
    await registration.register(input, client);
    await registration.register({ ...input, email: 'second@example.com' }, client);
    expect(audit.events.map((e) => e.metadata)).toEqual([{ bootstrap: true }, { bootstrap: false }]);
  });

  it('refuses a second account for the same email with 409 email_taken', async () => {
    const { registration } = build({ ...SETTINGS, allowRegistration: true });
    await registration.register(input, client);
    await expect(registration.register(input, client)).rejects.toMatchObject({
      kind: 'conflict',
      code: 'email_taken',
    });
  });

  it('fails closed (503) when the rate limiter is unavailable, before doing anything else', async () => {
    const { registration, throttle, users, hasher } = build();
    throttle.unavailable = true;
    await expect(registration.register(input, client)).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'authentication_unavailable',
    });
    expect(users.users).toHaveLength(0);
    expect(hasher.hashed).toEqual([]);
  });

  it('is rate limited per client address (429 once the budget is used)', async () => {
    const { registration } = build({ ...SETTINGS, allowRegistration: true });
    for (let i = 0; i < THROTTLE_RULES['register-address'].max; i++)
      await registration.register({ ...input, email: `user${i}@example.com` }, client);
    await expect(
      registration.register({ ...input, email: 'one-too-many@example.com' }, client),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('sign-in', () => {
  const credentials = {
    email: 'alice@example.com',
    password: 'alice password 1234',
    delivery: 'cookie' as const,
  };

  function withAlice() {
    const ctx = build();
    const alice = ctx.users.add({ email: 'alice@example.com' }, 'hash(alice password 1234)');
    return { ...ctx, alice };
  }

  it('signs in, creating a server-side session whose token is stored only as a hash, and audits it', async () => {
    const { authentication, sessionsRepo, audit, alice, clock } = withAlice();
    const signedIn = await authentication.login(credentials, client);
    expect(signedIn.user.id).toBe(alice.id);
    expect(signedIn.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionsRepo.sessions).toHaveLength(1);
    const stored = sessionsRepo.sessions[0]!;
    expect(stored.tokenHash).toBe(hashSessionToken(signedIn.token));
    expect(JSON.stringify(stored)).not.toContain(signedIn.token);
    expect(stored.absoluteExpiresAt.getTime() - clock.now().getTime()).toBe(SETTINGS.absoluteTtlMs);
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'auth.login_succeeded',
        metadata: { delivery: 'cookie' },
        resourceId: stored.id,
      }),
    ]);
  });

  it('gives ONE identical failure for an unknown email, a wrong password and a disabled account', async () => {
    const { authentication, users } = withAlice();
    users.add({ email: 'disabled@example.com', status: 'disabled' }, 'hash(disabled password 1)');
    const attempts = [
      { ...credentials, email: 'nobody@example.com' },
      { ...credentials, password: 'wrong password 12345' },
      { email: 'disabled@example.com', password: 'disabled password 1', delivery: 'cookie' as const },
    ];
    const errors = await Promise.all(
      attempts.map((a) => authentication.login(a, client).catch((e: unknown) => e)),
    );
    for (const error of errors) {
      expect(error).toMatchObject({
        kind: 'unauthenticated',
        code: 'invalid_credentials',
        message: 'Invalid email or password',
      });
    }
    expect(new Set(errors.map((e) => JSON.stringify({ ...(e as object) }))).size).toBe(1);
  });

  it('spends a verification for the unknown-account path too, so it cannot be told apart by timing', async () => {
    const { authentication, hasher } = withAlice();
    await authentication
      .login({ ...credentials, email: 'nobody@example.com' }, client)
      .catch(() => undefined);
    expect(hasher.dummyVerifications).toBe(1);
    await authentication
      .login({ ...credentials, password: 'wrong password 12345' }, client)
      .catch(() => undefined);
    expect(hasher.verified).toEqual(['wrong password 12345']);
  });

  it('records a failed sign-in in the audit trail only for an EXISTING account (an attacker cannot grow the table)', async () => {
    const { authentication, audit } = withAlice();
    await authentication
      .login({ ...credentials, email: 'nobody@example.com' }, client)
      .catch(() => undefined);
    expect(audit.events).toEqual([]);
    await authentication
      .login({ ...credentials, password: 'wrong password 12345' }, client)
      .catch(() => undefined);
    expect(audit.actions()).toEqual(['auth.login_failed']);
  });

  it('writes "throttled" once, on the failure that exhausts the account budget, and then refuses before verifying anything', async () => {
    const { authentication, audit, hasher } = withAlice();
    const max = THROTTLE_RULES['signin-account'].max;
    for (let i = 0; i < max; i++)
      await authentication
        .login({ ...credentials, password: `wrong password ${i} xx` }, client)
        .catch(() => undefined);
    expect(audit.actions().filter((a) => a === 'auth.login_throttled')).toEqual(['auth.login_throttled']);
    expect(audit.events.find((e) => e.action === 'auth.login_throttled')?.metadata).toEqual({
      scope: 'account',
    });

    const verifiedBefore = hasher.verified.length;
    await expect(authentication.login(credentials, client)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(hasher.verified.length).toBe(verifiedBefore); // even the RIGHT password does not get a hash computed
    expect(audit.actions().filter((a) => a === 'auth.login_throttled')).toHaveLength(1); // refusals are not re-recorded
  });

  it('counts the unknown account too, so the limiter itself does not reveal which accounts exist', async () => {
    const { authentication, throttle } = withAlice();
    await authentication
      .login({ ...credentials, email: 'nobody@example.com' }, client)
      .catch(() => undefined);
    expect(throttle.countOf('signin-account', 'nobody@example.com')).toBe(1);
    expect(throttle.countOf('signin-address', client.address)).toBe(1);
  });

  it('fails closed (503) when the rate limiter is unavailable: no verification, no session', async () => {
    const { authentication, throttle, hasher, sessionsRepo } = withAlice();
    throttle.unavailable = true;
    await expect(authentication.login(credentials, client)).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'authentication_unavailable',
    });
    expect(hasher.verified).toEqual([]);
    expect(sessionsRepo.sessions).toHaveLength(0);
  });

  it('forgives the account failures after a successful sign-in, and a limiter that cannot reset does not fail the sign-in', async () => {
    const { authentication, throttle } = withAlice();
    await authentication
      .login({ ...credentials, password: 'wrong password 12345' }, client)
      .catch(() => undefined);
    expect(throttle.countOf('signin-account', 'alice@example.com')).toBe(1);
    await authentication.login(credentials, client);
    expect(throttle.countOf('signin-account', 'alice@example.com')).toBe(0);

    const broken = vi.spyOn(throttle, 'reset').mockRejectedValue(new Error('redis down'));
    await expect(authentication.login(credentials, client)).resolves.toMatchObject({
      token: expect.any(String),
    });
    expect(broken).toHaveBeenCalled();
  });

  it('replaces a stored hash that is below the current policy after a successful sign-in, and only then', async () => {
    const { authentication, users, hasher, alice } = withAlice();
    await authentication.login(credentials, client);
    expect(hasher.hashed).toEqual([]);

    hasher.needsRehash = true;
    await authentication.login(credentials, client);
    expect(hasher.hashed).toEqual(['alice password 1234']);
    expect(users.hashes.get(alice.id)).toBe('hash(alice password 1234)');

    hasher.hashed.length = 0;
    await authentication
      .login({ ...credentials, password: 'wrong password 12345' }, client)
      .catch(() => undefined);
    expect(hasher.hashed).toEqual([]); // a failed sign-in never rehashes anything
  });

  it('answers the same generic failure even when the failure cannot be written to the audit trail', async () => {
    const { authentication, audit } = withAlice();
    audit.failWith = new Error('audit store unavailable');
    await expect(
      authentication.login({ ...credentials, password: 'wrong password 12345' }, client),
    ).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('records which carrier was requested, never a token', async () => {
    const { authentication, audit } = withAlice();
    const signedIn = await authentication.login({ ...credentials, delivery: 'token' }, client);
    expect(audit.events[0]?.metadata).toEqual({ delivery: 'token' });
    expect(JSON.stringify(audit.events)).not.toContain(signedIn.token);
  });
});

describe('sessions: validation, expiry, revocation', () => {
  async function signedIn() {
    const ctx = build();
    ctx.users.add({ email: 'alice@example.com' }, 'hash(alice password 1234)');
    const result = await ctx.authentication.login(
      { email: 'alice@example.com', password: 'alice password 1234', delivery: 'cookie' },
      client,
    );
    return { ...ctx, ...result };
  }

  it('resolves a valid token to the caller', async () => {
    const { sessions, token, user, session } = await signedIn();
    expect(await sessions.resolve(token)).toMatchObject({
      principal: { userId: user.id, sessionId: session.id },
      user: { email: 'alice@example.com' },
    });
  });

  it('answers null (one generic 401 upstream) for malformed, unknown, revoked, idle-expired, absolute-expired and disabled', async () => {
    const { sessions, sessionsRepo, users, clock, token, session, user } = await signedIn();
    const lookups = vi.spyOn(sessionsRepo, 'findByTokenHash');

    expect(await sessions.resolve('')).toBeNull();
    expect(await sessions.resolve('not-a-token')).toBeNull();
    expect(lookups).not.toHaveBeenCalled(); // garbage never reaches the database
    expect(await sessions.resolve('A'.repeat(43))).toBeNull(); // well-formed but unknown

    // idle expiry
    clock.advance(SETTINGS.idleTtlMs);
    expect(await sessions.resolve(token)).toBeNull();
    clock.advance(-SETTINGS.idleTtlMs);
    expect(await sessions.resolve(token)).not.toBeNull();

    // disabled user
    (users.users[0] as { status: string }).status = 'disabled';
    expect(await sessions.resolve(token)).toBeNull();
    (users.users[0] as { status: string }).status = 'active';

    // revoked
    await sessionsRepo.revoke(session.id, clock.now());
    expect(await sessions.resolve(token)).toBeNull();
    expect(user.id).toBeTruthy();
  });

  it('ends at the absolute expiry even when used continuously', async () => {
    const { sessions, clock, token } = await signedIn();
    const step = SETTINGS.idleTtlMs / 2;
    let elapsed = 0;
    while (elapsed + step < SETTINGS.absoluteTtlMs) {
      clock.advance(step);
      elapsed += step;
      expect(
        await sessions.resolve(token),
        `still valid after ${elapsed} ms of continuous use`,
      ).not.toBeNull();
    }
    clock.advance(SETTINGS.absoluteTtlMs - elapsed);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('slides the idle expiry on use but writes at most once a minute, and never moves it past the absolute expiry', async () => {
    const { sessions, sessionsRepo, clock, token } = await signedIn();
    const before = sessionsRepo.sessions[0]!.idleExpiresAt;
    clock.advance(30_000);
    await sessions.resolve(token);
    expect(sessionsRepo.touches).toBe(0); // under a minute: no write
    clock.advance(31_000);
    await sessions.resolve(token);
    expect(sessionsRepo.touches).toBe(1);
    expect(sessionsRepo.sessions[0]!.idleExpiresAt.getTime()).toBeGreaterThan(before.getTime());
    expect(sessionsRepo.sessions[0]!.idleExpiresAt.getTime()).toBeLessThanOrEqual(
      sessionsRepo.sessions[0]!.absoluteExpiresAt.getTime(),
    );
  });

  it('does not depend on the rate limiter: validation, logout and logout-all work while it is unavailable', async () => {
    const { sessions, throttle, token, session, user, audit } = await signedIn();
    throttle.unavailable = true;
    expect(await sessions.resolve(token)).not.toBeNull();
    await sessions.logout({ userId: user.id, sessionId: session.id });
    expect(await sessions.resolve(token)).toBeNull();
    expect(audit.actions()).toContain('auth.logout');
  });

  it('logout ends only the current session; logout-all ends every session of the user and says how many', async () => {
    const ctx = await signedIn();
    const second = await ctx.authentication.login(
      { email: 'alice@example.com', password: 'alice password 1234', delivery: 'token' },
      client,
    );
    await ctx.sessions.logout({ userId: ctx.user.id, sessionId: ctx.session.id });
    expect(await ctx.sessions.resolve(ctx.token)).toBeNull();
    expect(await ctx.sessions.resolve(second.token)).not.toBeNull();

    const third = await ctx.authentication.login(
      { email: 'alice@example.com', password: 'alice password 1234', delivery: 'token' },
      client,
    );
    const revoked = await ctx.sessions.logoutAll({ userId: ctx.user.id, sessionId: second.session.id });
    expect(revoked).toBe(2);
    expect(await ctx.sessions.resolve(second.token)).toBeNull();
    expect(await ctx.sessions.resolve(third.token)).toBeNull();
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'auth.logout_all',
      metadata: { revokedSessions: 2 },
    });
  });
});

describe('changing the password', () => {
  async function twoSessions() {
    const ctx = build();
    ctx.users.add({ email: 'alice@example.com' }, 'hash(old password 12345)');
    const login = () =>
      ctx.authentication.login(
        { email: 'alice@example.com', password: 'old password 12345', delivery: 'token' },
        client,
      );
    const current = await login();
    const other = await login();
    const auth = await ctx.sessions.resolve(current.token);
    return { ...ctx, current, other, auth: auth! };
  }

  it('replaces the password, ends the other sessions, rotates the current token, and audits the count', async () => {
    const { account, sessions, users, audit, current, other, auth } = await twoSessions();
    const changed = await account.changePassword(auth, 'old password 12345', 'brand new password 99');

    expect(users.hashes.get(auth.user.id)).toBe('hash(brand new password 99)');
    expect(await sessions.resolve(other.token)).toBeNull(); // every other session ended
    expect(await sessions.resolve(current.token)).toBeNull(); // the old token of THIS session no longer works
    expect(changed.token).not.toBe(current.token);
    expect(await sessions.resolve(changed.token)).toMatchObject({
      principal: { sessionId: current.session.id },
    }); // same session, new token
    expect(audit.events.at(-1)).toMatchObject({
      action: 'auth.password_changed',
      metadata: { revokedOtherSessions: 1 },
    });
  });

  it("keeps the session's creation time and expiry: rotation does not extend its life", async () => {
    const { account, sessions, current, auth } = await twoSessions();
    const changed = await account.changePassword(auth, 'old password 12345', 'brand new password 99');
    const after = await sessions.resolve(changed.token);
    expect(after?.session.createdAt).toEqual(current.session.createdAt);
    expect(after?.session.absoluteExpiresAt).toEqual(current.session.absoluteExpiresAt);
  });

  it('rejects a wrong current password (422), changes nothing, and counts the failure', async () => {
    const { account, users, throttle, sessionsRepo, auth } = await twoSessions();
    await expect(
      account.changePassword(auth, 'not the password 1', 'brand new password 99'),
    ).rejects.toMatchObject({
      kind: 'unprocessable',
      code: 'invalid_current_password',
    });
    expect(users.hashes.get(auth.user.id)).toBe('hash(old password 12345)');
    expect(sessionsRepo.sessions.every((s) => s.revokedAt === null)).toBe(true);
    expect(throttle.countOf('password-account', auth.user.id)).toBe(1);
  });

  it('is rate limited per user, and fails closed (503) when the limiter is unavailable', async () => {
    const { account, throttle, auth } = await twoSessions();
    throttle.unavailable = true;
    await expect(
      account.changePassword(auth, 'old password 12345', 'brand new password 99'),
    ).rejects.toMatchObject({
      code: 'authentication_unavailable',
    });
    throttle.unavailable = false;
    for (let i = 0; i < THROTTLE_RULES['password-account'].max; i++)
      await account
        .changePassword(auth, `wrong ${i} password xx`, 'brand new password 99')
        .catch(() => undefined);
    await expect(
      account.changePassword(auth, 'old password 12345', 'brand new password 99'),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  describe('a failed password change is audited (auth.password_change_failed)', () => {
    const WRONG = 'not the password 1';
    const NEW = 'brand new password 99';
    const failedEvents = (audit: FakeAudit) =>
      audit.events.filter((e) => e.action === 'auth.password_change_failed');

    it('records a wrong current password with its reason, the user, and nothing secret', async () => {
      const { account, audit, auth, users, sessionsRepo } = await twoSessions();
      await expect(account.changePassword(auth, WRONG, NEW)).rejects.toMatchObject({
        kind: 'unprocessable',
        code: 'invalid_current_password',
      });
      expect(failedEvents(audit)).toEqual([
        expect.objectContaining({
          action: 'auth.password_change_failed',
          result: 'failure',
          actorUserId: auth.user.id,
          resourceType: 'user',
          resourceId: auth.user.id,
          metadata: { reason: 'wrong_current_password' },
        }),
      ]);
      const recorded = JSON.stringify(audit.events);
      for (const secret of [WRONG, NEW, 'old password 12345', 'hash('])
        expect(recorded).not.toContain(secret);
      // A failed attempt changes nothing else: the password and every session are untouched.
      expect(users.hashes.get(auth.user.id)).toBe('hash(old password 12345)');
      expect(sessionsRepo.sessions.every((s) => s.revokedAt === null)).toBe(true);
    });

    it('records the rate-limit exhaustion ONCE, on the failure that used the budget up, and not the refusals after it', async () => {
      const { account, audit, auth } = await twoSessions();
      const max = THROTTLE_RULES['password-account'].max;
      for (let i = 0; i < max; i++)
        await expect(account.changePassword(auth, `${WRONG} ${i}`, NEW)).rejects.toMatchObject({
          code: 'invalid_current_password',
        });
      expect(failedEvents(audit).map((e) => e.metadata)).toEqual([
        ...Array.from({ length: max }, () => ({ reason: 'wrong_current_password' })),
        { reason: 'rate_limited' },
      ]);

      // From now on the attempt is refused with 429 BEFORE anything is verified, and adds no further audit volume.
      const total = audit.events.length;
      for (let i = 0; i < 3; i++)
        await expect(account.changePassword(auth, WRONG, NEW)).rejects.toMatchObject({
          kind: 'rate_limited',
        });
      expect(audit.events.length).toBe(total);
    });

    it('never changes the response when the audit store fails: still 422 for a wrong password, still 429 once limited', async () => {
      const { account, audit, auth } = await twoSessions();
      audit.failWith = new Error('audit store unavailable');
      const max = THROTTLE_RULES['password-account'].max;
      for (let i = 0; i < max; i++)
        await expect(account.changePassword(auth, `${WRONG} ${i}`, NEW)).rejects.toMatchObject({
          kind: 'unprocessable',
          code: 'invalid_current_password',
        }); // including the failure that exhausts the budget
      await expect(account.changePassword(auth, WRONG, NEW)).rejects.toMatchObject({ kind: 'rate_limited' });
      expect(failedEvents(audit)).toEqual([]); // nothing could be written, and nothing leaked into the response
    });

    it('still records the attempt when the limiter is unavailable, and the caller still gets the fail-closed 503', async () => {
      const { account, audit, auth, throttle } = await twoSessions();
      vi.spyOn(throttle, 'hit').mockRejectedValue(
        new AppError(
          'unavailable',
          'authentication_unavailable',
          'Authentication is temporarily unavailable',
        ),
      );
      await expect(account.changePassword(auth, WRONG, NEW)).rejects.toMatchObject({
        kind: 'unavailable',
        code: 'authentication_unavailable',
      });
      expect(failedEvents(audit).map((e) => e.metadata)).toEqual([{ reason: 'wrong_current_password' }]);
    });

    it('does not record a successful change as a failure, nor a failure when the password was right', async () => {
      const { account, audit, auth } = await twoSessions();
      await account.changePassword(auth, 'old password 12345', NEW);
      expect(failedEvents(audit)).toEqual([]);
      expect(audit.actions()).toContain('auth.password_changed');
    });
  });
});
