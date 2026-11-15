import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ChangePasswordResponse,
  type MeResponse,
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  meResponseSchema,
} from '@agentos/contracts';
import { ApiStandardErrors, ApiZodBody, ApiZodResponse } from '../../../common/openapi';
import { createZodDto } from '../../../common/zod-validation.pipe';
import { AccountService } from '../application/account.service';
import { CLOCK, IDENTITY_SETTINGS, type Clock, type IdentitySettings } from '../application/ports';
import { CurrentAuth } from './decorators';
import type { HttpResponse, RequestAuth } from './http';
import { toSessionInfo, toUserDto } from './mappers';
import { setSessionCookie } from './session-cookie';

class ChangePasswordDto extends createZodDto(changePasswordRequestSchema) {}

@ApiTags('identity')
@ApiBearerAuth()
@ApiCookieAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in user and the state of the current session.' })
  @ApiZodResponse(200, meResponseSchema)
  @ApiStandardErrors(401)
  me(@CurrentAuth() auth: RequestAuth): MeResponse {
    return { user: toUserDto(auth.user), session: toSessionInfo(auth.session) };
  }

  @Post('password')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Change the password. Ends every other session and rotates this one: cookie clients get a new cookie, bearer clients the new token in the body.',
  })
  @ApiZodBody(changePasswordRequestSchema)
  @ApiZodResponse(200, changePasswordResponseSchema)
  @ApiStandardErrors(400, 401, 403, 422, 429, 503)
  async changePassword(
    @CurrentAuth() auth: RequestAuth,
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ChangePasswordResponse> {
    const changed = await this.accounts.changePassword(auth, body.currentPassword, body.newPassword);
    if (auth.carrier === 'cookie')
      setSessionCookie(response, this.settings, changed.token, changed.session, this.clock.now());
    return {
      session: toSessionInfo(changed.session),
      ...(auth.carrier === 'token' ? { token: changed.token } : {}),
    };
  }
}
