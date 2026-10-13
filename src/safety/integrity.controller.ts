import { Body, Get, Post } from '@nestjs/common';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import { DismissFlagDto } from './dto/integrity.dto.js';
import { IntegrityService, type IntegrityItem } from './integrity.service.js';

/** A7.3 Leaderboard integrity flags, for the staff who run the boards (A6.5 roles). */
@AdminController('integrity')
@AdminRoles('admin', 'content')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @Get('flags')
  flags(): Promise<{ items: IntegrityItem[] }> {
    return this.integrity.flags();
  }

  /** A flag looked at and found fine: it does not return for the same evidence. Audited. */
  @Post('dismissals')
  dismiss(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() body: DismissFlagDto): Promise<void> {
    return this.integrity.dismiss(admin.adminId, body.userId, body.key, body.reason);
  }
}
