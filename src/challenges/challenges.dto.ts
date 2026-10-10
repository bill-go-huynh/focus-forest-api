import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import type {
  ChallengeGoal,
  ChallengeKind,
  ChallengeMeasure,
  ChallengePhase,
} from './challenge-rules.js';

export class CreateChallengeDto {
  @IsString({ message: 'templateId must be a template id.' })
  @MaxLength(64)
  templateId!: string;

  /** Friends to invite (friend and group challenges). */
  @IsOptional()
  @IsArray({ message: 'invite must be a list of user ids.' })
  @ArrayMaxSize(9)
  @IsUUID('all', { each: true, message: 'invite must be a list of user ids.' })
  invite?: string[];
}

export class InviteDto {
  @IsArray({ message: 'userIds must be a list of user ids.' })
  @ArrayMaxSize(9)
  @IsUUID('all', { each: true, message: 'userIds must be a list of user ids.' })
  userIds!: string[];
}

export interface PersonDto {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * One challenge as a participant or invitee sees it. Progress is in the template's unit (minutes,
 * sessions, or days). Nothing says "failed": a finished challenge not reached is simply `ended`.
 */
export interface ChallengeDto {
  id: string;
  template: {
    id: string;
    kind: ChallengeKind;
    measure: ChallengeMeasure;
    goal: ChallengeGoal;
    target: number;
    dailyMinutes: number;
    days: number;
  };
  startDate: string;
  endDate: string;
  phase: ChallengePhase;
  completedAt: string | null;
  /** Shared goal: everyone's total. Each: the viewer's own value. */
  progress: { value: number; target: number };
  /** Joined participants, without anyone the viewer blocks or is blocked by. */
  participants: { user: PersonDto; value: number; reached: boolean }[];
  invited: PersonDto[];
  you: { status: 'invited' | 'joined' };
}

export interface ChallengeListsDto {
  current: ChallengeDto[];
  invitations: ChallengeDto[];
  /** The latest 20. */
  finished: ChallengeDto[];
}
