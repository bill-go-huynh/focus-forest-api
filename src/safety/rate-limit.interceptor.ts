import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

import { Clock } from '../common/clock.js';
import type { AuthenticatedRequest } from '../identity/current-user.decorator.js';
import { RATE_LIMIT, type RateLimitKey, type RateLimitRule } from './rate-limit.decorator.js';
import { RateLimitedException, RateLimitService } from './rate-limit.service.js';

/**
 * Counts each limited request (A7.2) after the guards, so a signed-in user is known, and before
 * validation and the handler: a refused request does nothing. Sets `Retry-After` on a refusal.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
    private readonly clock: Clock,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const rule = this.reflector.get<RateLimitRule | undefined>(RATE_LIMIT, context.getHandler());
    if (!rule) return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const now = this.clock.now();
    try {
      for (const key of rule.per) {
        const value = keyOf(key, request);
        if (value) await this.limits.hit(rule.name, key, value, now);
      }
    } catch (error) {
      if (error instanceof RateLimitedException) {
        http.getResponse<Response>().setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
    return next.handle();
  }
}

function keyOf(key: RateLimitKey, request: AuthenticatedRequest): string | null {
  if (key === 'user') return request.user?.userId ?? null;
  if (key === 'ip') return request.ip ?? request.socket.remoteAddress ?? null;
  const email = (request.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== '' ? email.trim().toLowerCase() : null;
}
