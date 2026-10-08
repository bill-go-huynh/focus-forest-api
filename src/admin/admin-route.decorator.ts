import {
  applyDecorators,
  Controller,
  createParamDecorator,
  SetMetadata,
  UseGuards,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

import type { AdminRole } from '../generated/prisma/client.js';
import { IS_ADMIN_ROUTE } from '../identity/access-token.guard.js';
import { AdminGuard } from './admin.guard.js';

export const ADMIN_ROLES = 'admin:roles';

export interface AuthenticatedAdmin {
  adminId: string;
  email: string;
  role: AdminRole;
}
export type AdminRequest = Request & { admin?: AuthenticatedAdmin };

/**
 * An admin controller under `/admin/<path>`: the app's access-token guard steps aside and the
 * admin guard requires an active admin's token. One decorator, so no admin route can exist
 * without the admin guard.
 */
export function AdminController(path: string): ClassDecorator {
  return applyDecorators(
    Controller(path ? `admin/${path}` : 'admin'),
    SetMetadata(IS_ADMIN_ROUTE, true),
    UseGuards(AdminGuard),
  );
}

/** Roles allowed on a route; without it, any active admin (support included). */
export const AdminRoles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ROLES, roles);

/** A route an admin reaches without a token: sign-in only. */
export const ADMIN_PUBLIC = 'admin:public';
export const AdminPublic = (): MethodDecorator => SetMetadata(ADMIN_PUBLIC, true);

/** The signed-in admin, set by the admin guard. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAdmin => {
    const admin = context.switchToHttp().getRequest<AdminRequest>().admin;
    if (!admin) throw new Error('CurrentAdmin used on a route without an authenticated admin.');
    return admin;
  },
);
