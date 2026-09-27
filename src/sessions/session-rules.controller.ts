import { Controller, Get } from '@nestjs/common';

import { ProductConfigService } from '../product-config/product-config.service.js';

/** The session rules a client needs to run its timer. Not the whole configuration. */
export interface SessionRulesResponse {
  /** The configuration version these values come from. */
  version: number;
  minValidMinutes: number;
  maxPauseMinutes: number;
}

// The same rules apply to every user, so the route is not under /me.
@Controller('session-rules')
export class SessionRulesController {
  constructor(private readonly config: ProductConfigService) {}

  @Get()
  async get(): Promise<SessionRulesResponse> {
    const active = await this.config.active();
    return {
      version: active.version,
      minValidMinutes: active.get('session.minValidMinutes'),
      maxPauseMinutes: active.get('session.maxPauseMinutes'),
    };
  }
}
