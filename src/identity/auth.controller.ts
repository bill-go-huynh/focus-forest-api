import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService, type AuthResult, type GoogleAuthResult } from './auth.service.js';
import { GoogleSignInDto, RefreshDto, SignInDto, SignUpDto } from './dto/auth.dto.js';
import { Public } from './public.decorator.js';
import { RateLimit } from '../safety/rate-limit.decorator.js';

@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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

  @RateLimit('refresh', 'ip')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshDto): Promise<AuthResult> {
    return this.auth.refresh(body.refreshToken);
  }
}
