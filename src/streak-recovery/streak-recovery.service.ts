import { Injectable } from '@nestjs/common';

import type { LocalDate } from '../common/local-date.js';
import type { StreakResponse } from '../consistency/consistency.dto.js';
import { StreakService } from '../consistency/streak.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseProgressionResult } from '../progression/achievement-evaluation.js';
import { AchievementsService } from '../progression/achievements.service.js';
import type { SessionProgressionDto } from '../progression/badge.dto.js';

export interface RecoveryResponse extends StreakResponse {
  /**
   * What this recovery caused in progression (A4.2.G): the badges its recovered day earned (a
   * longer longest streak). Stored with the recovery and answered unchanged on a repeated
   * acceptance; null for recoveries stored before A4.2.G.
   */
  progression: SessionProgressionDto | null;
}

/**
 * Accepting a streak recovery (A3.2), orchestrated above Consistency and Progression so neither
 * depends on the other the wrong way (Progression reads the streak history; Consistency never
 * reads Progression). One transaction under the user's row lock: the recovery is stored by the
 * streak domain, then achievements are evaluated from the same stored truth, and the result is
 * stored with the recovery. A grant commits with its recovery, or neither does.
 */
@Injectable()
export class StreakRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly streak: StreakService,
    private readonly achievements: AchievementsService,
  ) {}

  async recover(
    userId: string,
    missedDate: LocalDate,
  ): Promise<{ response: RecoveryResponse; created: boolean }> {
    const { stored, created } = await this.prisma.$transaction(async (tx) => {
      const { recovery, created } = await this.streak.acceptIn(tx, userId, missedDate);
      // A repeat answers what the first acceptance stored: nothing is evaluated again.
      if (!created) return { stored: recovery.progressionResult, created };
      const progression = await this.achievements.evaluateRecovery(tx, userId, missedDate);
      await tx.streakRecovery.update({
        where: { userId_missedDate: { userId, missedDate: recovery.missedDate } },
        data: { progressionResult: progression as unknown as Prisma.InputJsonValue },
      });
      return { stored: progression, created };
    });
    const progression = stored === null ? null : parseProgressionResult(stored);
    return {
      response: {
        ...(await this.streak.view(userId)),
        progression: progression && {
          newlyEarnedBadges: await this.achievements.earnedBadges(
            userId,
            progression.newlyEarnedBadgeIds,
          ),
        },
      },
      created,
    };
  }
}
