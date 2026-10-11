import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const LEADERBOARD_SCOPES = ['friends', 'global', 'event'] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];
export type LeaderboardPeriodKind = 'weekly' | 'monthly' | 'event';

export class LeaderboardQueryDto {
  /** Friends (mutual follows) by default: the most prominent board (docs/02). */
  @IsOptional()
  @IsIn(LEADERBOARD_SCOPES, { message: 'scope must be friends, global, or event.' })
  scope?: LeaderboardScope;

  @IsOptional()
  @IsIn(['weekly', 'monthly'], { message: 'period must be weekly or monthly.' })
  period?: 'weekly' | 'monthly';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  eventId?: string;
}

export interface LeaderboardRowDto {
  /** Ties share a rank. No rank change and no "you dropped" (docs/01). */
  rank: number;
  person: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  /** The fair score, 0 to 1000 (spec §16.4: never raw hours alone). */
  score: number;
  you: boolean;
}

/** A plain, readable list with the viewer's own row (docs/01, docs/11). */
export interface LeaderboardDto {
  scope: LeaderboardScope;
  period: { kind: LeaderboardPeriodKind; startDate: string; endDate: string };
  /** Whether the viewer appears on boards (`/me/privacy` `leaderboards`). */
  optedIn: boolean;
  rows: LeaderboardRowDto[];
  /** The viewer's row, also when beyond the listed rows; null when not on the board. */
  you: LeaderboardRowDto | null;
  /** Event boards with teams; null otherwise. */
  teams: { id: string; name: string; rank: number; score: number; members: number }[] | null;
}
