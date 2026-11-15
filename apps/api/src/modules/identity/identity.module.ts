import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { APP_CONFIG, type ApiConfig } from '../config';
import { DatabaseModule } from '../database';
import { RedisModule, RedisService } from '../redis';
import { AccountService } from './application/account.service';
import { AuthenticationService } from './application/authentication.service';
import {
  CLOCK,
  IDENTITY_SETTINGS,
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  THROTTLE,
  USER_REPOSITORY,
  type IdentitySettings,
} from './application/ports';
import { RegistrationService } from './application/registration.service';
import { SessionService } from './application/session.service';
import { UserDirectory } from './application/user-directory';
import { PrismaSessionRepository } from './infrastructure/prisma-session.repository';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { RedisThrottle } from './infrastructure/redis-throttle';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher';
import { AuthController } from './presentation/auth.controller';
import { AuthenticationGuard } from './presentation/authentication.guard';
import { MeController } from './presentation/me.controller';
import { sessionCookieName } from './presentation/session-cookie';

/** Settings the Identity services take from configuration, resolved once. */
export function identitySettings(config: ApiConfig): IdentitySettings {
  const secureCookies = new URL(config.WEB_ORIGIN).protocol === 'https:';
  return {
    allowRegistration: config.AUTH_ALLOW_REGISTRATION,
    idleTtlMs: config.SESSION_IDLE_TTL_MINUTES * 60_000,
    absoluteTtlMs: config.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000,
    webOrigin: config.WEB_ORIGIN,
    secureCookies,
    cookieName: sessionCookieName(secureCookies),
  };
}

/** Prefix of the rate-limit counters in Redis. */
export const THROTTLE_KEY_PREFIX = 'agentos:authn';

/**
 * Identity: who you are (ADR-0010). Local email/password authentication with server-side sessions. It owns users, credentials and
 * sessions, depends on no other domain module, and hands the rest of the system a `Principal`.
 */
@Module({
  imports: [DatabaseModule, RedisModule, AuditModule],
  controllers: [AuthController, MeController],
  providers: [
    { provide: IDENTITY_SETTINGS, inject: [APP_CONFIG], useFactory: identitySettings },
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: PASSWORD_HASHER, useFactory: () => new ScryptPasswordHasher() },
    {
      provide: THROTTLE,
      inject: [RedisService],
      useFactory: (redis: RedisService) => new RedisThrottle(redis, THROTTLE_KEY_PREFIX),
    },
    { provide: CLOCK, useValue: { now: () => new Date() } },
    SessionService,
    RegistrationService,
    AuthenticationService,
    AccountService,
    UserDirectory,
    AuthenticationGuard,
  ],
  // The guard is registered globally by the composition root (AppModule); UserDirectory is for other modules.
  exports: [AuthenticationGuard, UserDirectory],
})
export class IdentityModule {}
