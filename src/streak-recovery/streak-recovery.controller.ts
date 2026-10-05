import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RecoveryDto } from '../consistency/consistency.dto.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { StreakRecoveryService, type RecoveryResponse } from './streak-recovery.service.js';

@Controller('me/streak')
export class StreakRecoveryController {
  constructor(private readonly recoveries: StreakRecoveryService) {}

  /**
   * Accepts the offered recovery. Idempotent: 201 when stored, 200 when it already was (with
   * the same progression result).
   */
  @Post('recoveries')
  async recover(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RecoveryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecoveryResponse> {
    const { response, created } = await this.recoveries.recover(user.userId, body.missedDate);
    res.status(created ? 201 : 200);
    return response;
  }
}
