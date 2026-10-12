import { Body, Get, HttpCode, Post } from '@nestjs/common';

import { AdminAuthService } from './admin-auth.service.js';
import {
  AdminController,
  AdminRoles,
  AdminPublic,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from './admin-route.decorator.js';
import {
  AdminSignInDto,
  type AdminIdentity,
  type AdminSignInResponse,
} from './dto/admin-auth.dto.js';

@AdminController('auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('sign-in')
  @AdminPublic()
  @HttpCode(200)
  signIn(@Body() body: AdminSignInDto): Promise<AdminSignInResponse> {
    return this.auth.signIn(body.email, body.password);
  }

  /** The signed-in admin, to show who is signed in and what their role allows. */
  @Get('me')
  @AdminRoles('admin', 'support', 'moderator', 'content')
  me(@CurrentAdmin() admin: AuthenticatedAdmin): AdminIdentity {
    return { id: admin.adminId, email: admin.email, role: admin.role };
  }
}
