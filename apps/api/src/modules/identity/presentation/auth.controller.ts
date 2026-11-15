import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type LoginResponse,
  type RegisterResponse,
  loginRequestSchema,
  loginResponseSchema,
  registerRequestSchema,
  registerResponseSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { AuthenticationService } from '../application/authentication.service';
import { CLOCK, IDENTITY_SETTINGS, type Clock, type IdentitySettings } from '../application/ports';
import { RegistrationService } from '../application/registration.service';
import { SessionService } from '../application/session.service';
import { assertAllowedOrigin } from './csrf';
import { CurrentAuth, Public } from './decorators';
import type { HttpRequest, HttpResponse, RequestAuth } from './http';
import { clientOf, toSessionInfo, toUserDto } from './mappers';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

class RegisterDto extends createZodDto(registerRequestSchema) {}
class LoginDto extends createZodDto(loginRequestSchema) {}

/** Thin controller: validate (global pipe), call the service, shape the response. No decisions are made here. */
@ApiTags('identity')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly authentication: AuthenticationService,
    private readonly sessions: SessionService,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({
    summary:
      'Create an account. Allowed for the first user of an empty instance, and afterwards only if the operator enabled registration.',
  })
  @ApiZodBody(registerRequestSchema)
  @ApiZodResponse(201, registerResponseSchema)
  @ApiStandardErrors(400, 403, 409, 429, 503)
  async register(@Body() body: RegisterDto, @Req() request: HttpRequest): Promise<RegisterResponse> {
    assertAllowedOrigin(request, this.settings.webOrigin, { required: false }); // login/registration CSRF: only when an Origin is sent
    const user = await this.registration.register(body, clientOf(request));
    return { user: toUserDto(user) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Sign in with email and password. `delivery: "cookie"` (default) sets an HttpOnly session cookie; `"token"` returns the session token once in the body.',
  })
  @ApiZodBody(loginRequestSchema)
  @ApiZodResponse(200, loginResponseSchema)
  @ApiStandardErrors(400, 401, 429, 503)
  async login(
    @Body() body: LoginDto,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<LoginResponse> {
    assertAllowedOrigin(request, this.settings.webOrigin, { required: false });
    const signedIn = await this.authentication.login(body, clientOf(request));
    if (body.delivery === 'cookie')
      setSessionCookie(response, this.settings, signedIn.token, signedIn.session, this.clock.now());
    return {
      user: toUserDto(signedIn.user),
      session: toSessionInfo(signedIn.session),
      ...(body.delivery === 'token' ? { token: signedIn.token } : {}),
    };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'End the current session.' })
  @ApiStandardErrors(401, 403)
  async logout(
    @CurrentAuth() auth: RequestAuth,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.sessions.logout(auth.principal);
    if (auth.carrier === 'cookie') clearSessionCookie(response, this.settings);
  }

  @Post('logout-all')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'End every session of the signed-in user, this one included.' })
  @ApiStandardErrors(401, 403)
  async logoutAll(
    @CurrentAuth() auth: RequestAuth,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.sessions.logoutAll(auth.principal);
    if (auth.carrier === 'cookie') clearSessionCookie(response, this.settings);
  }
}
