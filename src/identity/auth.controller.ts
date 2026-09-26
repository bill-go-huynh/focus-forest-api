import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService, type AuthResult } from './auth.service.js';
import { RefreshDto, SignInDto, SignUpDto } from './dto/auth.dto.js';
import { Public } from './public.decorator.js';

@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('sign-up')
  signUp(@Body() body: SignUpDto): Promise<AuthResult> {
    return this.auth.signUp(body.email, body.password);
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() body: SignInDto): Promise<AuthResult> {
    return this.auth.signIn(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshDto): Promise<AuthResult> {
    return this.auth.refresh(body.refreshToken);
  }
}
