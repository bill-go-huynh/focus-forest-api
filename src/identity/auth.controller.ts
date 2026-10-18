import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService, type AuthResult, type GoogleAuthResult } from './auth.service.js';
import {
  GoogleSignInDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RefreshDto,
  SignInDto,
  SignUpDto,
} from './dto/auth.dto.js';
import { PasswordResetService } from './password-reset.service.js';
import { Public } from './public.decorator.js';
import { RateLimit } from '../safety/rate-limit.decorator.js';

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @RateLimit('signUp', 'ip')
  @Post('sign-up')
  signUp(@Body() body: SignUpDto): Promise<AuthResult> {
    return this.auth.signUp(body.email, body.password);
  }

  @RateLimit('signIn', 'ip', 'email')
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() body: SignInDto): Promise<AuthResult> {
    return this.auth.signIn(body.email, body.password);
  }

  /** W.2 Signs in with Google, creating the account the first time. */
  @RateLimit('signIn', 'ip')
  @Post('google')
  @HttpCode(HttpStatus.OK)
  google(@Body() body: GoogleSignInDto): Promise<GoogleAuthResult> {
    return this.auth.signInWithGoogle(body.idToken, body.timezone);
  }

  /** W.3 Emails a code to set a new password. Answers the same whether the email has an account. */
  @RateLimit('signIn', 'ip', 'email')
  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordReset(@Body() body: PasswordResetRequestDto): Record<string, never> {
    this.passwordReset.request(body.email);
    return {};
  }

  /** W.3 The emailed code sets a new password, signs out other devices, and signs in here. */
  @RateLimit('signIn', 'ip', 'email')
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  confirmPasswordReset(@Body() body: PasswordResetConfirmDto): Promise<AuthResult> {
    return this.passwordReset.confirm(body.email, body.code, body.password);
  }

  @RateLimit('refresh', 'ip')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshDto): Promise<AuthResult> {
    return this.auth.refresh(body.refreshToken);
  }
}
