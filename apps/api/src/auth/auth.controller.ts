import {
  credentialsSchema,
  signupSchema,
  type Credentials,
  type SessionUser,
  type Signup,
} from '@kan/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { AuthRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';

@Controller('auth')
@AuthRate()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * `@Public()` because this is how a caller gets a token in the first place.
   *
   * These are the only routes in the API without one besides `/health`, and the
   * whole controller sits in the `auth` rate bucket rather than the global one:
   * they are the two that run scrypt, which is memory-hard by design and
   * therefore the cheapest lever an attacker has on this process. `RATE_LIMIT_AUTH`
   * defaults to 5/minute against the global 240.
   */
  @Post('signup')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  signup(@Body(new ZodValidationPipe(signupSchema)) body: Signup): Promise<SessionUser> {
    return this.auth.signup(body);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(credentialsSchema)) body: Credentials): Promise<SessionUser> {
    return this.auth.login(body);
  }

  /** The profile behind the presented token. Authenticated, unlike the two above. */
  @Get('me')
  me(@CurrentUser() user: TokenUser): Promise<SessionUser> {
    return this.auth.profile(user.id);
  }
}
