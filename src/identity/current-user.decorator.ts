import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

/** The signed-in user, set by the access-token guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new Error('CurrentUser used on a route without an authenticated user.');
    return user;
  },
);
