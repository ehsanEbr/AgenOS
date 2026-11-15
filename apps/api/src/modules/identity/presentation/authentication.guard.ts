import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { notAuthenticated } from '../application/errors';
import { IDENTITY_SETTINGS, type IdentitySettings } from '../application/ports';
import { SessionService } from '../application/session.service';
import { assertAllowedOrigin, assertJsonWhenBodyPresent, isUnsafeMethod } from './csrf';
import { IS_PUBLIC_KEY } from './decorators';
import { type HttpRequest, type SessionCarrier, header } from './http';
import { readCookie } from './session-cookie';

/**
 * Authenticates every request that is not marked `@Public()` (registered globally in AppModule, ADR-0010 decision 5).
 *
 * Cookie and bearer clients are two CARRIERS of the same server-side session, not two authentication models:
 * both end in `SessionService.resolve`, with identical expiry, revocation and rotation rules. A request that presents BOTH is
 * rejected, so one request is authenticated by exactly one carrier. Missing, malformed, unknown, revoked and expired credentials
 * all give the same 401.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const presented = this.credentialOf(request);
    if (!presented) throw notAuthenticated();

    // CSRF defense applies to the cookie carrier only, and before anything else about the credential is looked at.
    if (presented.carrier === 'cookie' && isUnsafeMethod(request.method)) {
      assertAllowedOrigin(request, this.settings.webOrigin, { required: true });
      assertJsonWhenBodyPresent(request);
    }

    const authenticated = await this.sessions.resolve(presented.token);
    if (!authenticated) throw notAuthenticated();
    request.auth = { ...authenticated, carrier: presented.carrier };
    return true;
  }

  private credentialOf(request: HttpRequest): { carrier: SessionCarrier; token: string } | null {
    const cookie = readCookie(header(request, 'cookie'), this.settings.cookieName);
    const bearer = /^Bearer\s+(\S+)$/i.exec(header(request, 'authorization') ?? '')?.[1];
    if (cookie !== undefined && bearer !== undefined) return null; // two carriers at once: refused
    if (bearer !== undefined) return { carrier: 'token', token: bearer };
    if (cookie !== undefined) return { carrier: 'cookie', token: cookie };
    return null;
  }
}
