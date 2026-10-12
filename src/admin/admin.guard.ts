import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AdminRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ADMIN_PUBLIC, ADMIN_ROLES, type AdminRequest } from './admin-route.decorator.js';
import { ADMIN_TOKENS, type AdminTokens } from './admin-tokens.js';

/**
 * The roles a route allows when it names none: the early admin's. Content staff (A6.4) reach
 * only the routes that name them, so a new route never opens to them by default.
 */
const EARLY_ROLES: readonly AdminRole[] = ['admin', 'support', 'moderator'];

/**
 * Every admin route requires an active admin's token, and the route's roles when it names them.
 * The role and status are read from the database on each request, never trusted from the token,
 * so disabling an admin or changing a role takes effect at once.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ADMIN_TOKENS) private readonly tokens: AdminTokens | null,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.tokens) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The admin is not configured on this server.',
        code: 'admin_disabled',
      });
    }
    if (this.reflector.get<boolean | undefined>(ADMIN_PUBLIC, context.getHandler())) return true;

    const request = context.switchToHttp().getRequest<AdminRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    const verified = scheme === 'Bearer' && token ? await this.tokens.verify(token) : null;
    if (!verified) throw new UnauthorizedException('Sign in to the admin to continue.');

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: verified.adminId },
      select: { id: true, email: true, role: true, status: true },
    });
    if (admin?.status !== 'active') {
      throw new UnauthorizedException('Sign in to the admin to continue.');
    }
    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!(roles ?? EARLY_ROLES).includes(admin.role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: "Your role can't do this.",
        code: 'admin_role_forbidden',
      });
    }
    request.admin = { adminId: admin.id, email: admin.email, role: admin.role };
    return true;
  }
}
