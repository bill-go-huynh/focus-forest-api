import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PrismaService } from '../prisma/prisma.service.js';
import { AccessTokens } from './access-tokens.js';
import type { AuthenticatedRequest } from './current-user.decorator.js';
import { IS_PUBLIC } from './public.decorator.js';

/** Global guard: every route requires a valid access token of an active user unless @Public(). */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokens,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    const verified = scheme === 'Bearer' && token ? await this.accessTokens.verify(token) : null;
    if (!verified) throw new UnauthorizedException('Sign in to continue.');

    const user = await this.prisma.user.findUnique({
      where: { id: verified.userId },
      select: { status: true },
    });
    if (user?.status !== 'active') throw new UnauthorizedException('Sign in to continue.');

    request.user = { userId: verified.userId };
    return true;
  }
}
