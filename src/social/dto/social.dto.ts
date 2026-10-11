import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

import type { ReactionKindId } from '../reaction-target.js';
import { PRIVACY_LEVELS, type PrivacyLevel, type PrivacyCategory } from '../visibility.js';

/** How the signed-in user and another user follow each other. Friends = mutual follows. */
export interface RelationshipResponse {
  following: boolean;
  followedBy: boolean;
  friends: boolean;
}

/** Identity is shown to every signed-in user who is not blocked (A5.1 decision). */
export interface UserSummaryResponse {
  id: string;
  username: string | null;
  displayName: string | null;
  /** Null until avatar upload exists. Clients show initials. */
  avatarUrl: string | null;
  relationship: RelationshipResponse;
}

/** `GET /users/:id`: identity, the profile when its privacy allows, and what else is visible. */
export interface UserCardResponse extends UserSummaryResponse {
  /** Null when the profile is hidden from this viewer (see `visible.profile`). */
  bio: string | null;
  joinDate: string | null;
  visible: Record<PrivacyCategory, boolean>;
}

export interface BlockedUserResponse {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string;
}

/** A5.2: the reactions on one target. Counts only, every kind present; `mine` is the viewer's. */
export interface ReactionSummaryResponse {
  /** `forest`, `tree:YYYY-MM`, or `badge:<badge id>`. */
  target: string;
  counts: Record<ReactionKindId, number>;
  mine: ReactionKindId[];
}

/** A5.2: one reaction the signed-in user received. */
export interface ReactionReceivedResponse {
  id: string;
  reaction: ReactionKindId;
  target: string;
  createdAt: string;
  from: UserSummaryResponse;
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export class SearchUsersQuery {
  @IsString({ message: 'q must be text.' })
  @MaxLength(64, { message: 'q is too long.' })
  q!: string;
}

export class CursorQuery {
  @IsOptional()
  @IsString({ message: 'cursor must be text.' })
  @MaxLength(512, { message: 'cursor is too long.' })
  cursor?: string;
}

const LEVEL_MESSAGE = `must be one of: ${PRIVACY_LEVELS.join(', ')}.`;
const isSent =
  (key: string) =>
  (dto: object): boolean =>
    (dto as Record<string, unknown>)[key] !== undefined;

/** Any subset of the five categories. Unknown keys are rejected by the validation pipe. */
export class UpdatePrivacyDto implements Partial<Record<PrivacyCategory, PrivacyLevel>> {
  @ValidateIf(isSent('profile'))
  @IsIn(PRIVACY_LEVELS, { message: `profile ${LEVEL_MESSAGE}` })
  profile?: PrivacyLevel;

  @ValidateIf(isSent('forest'))
  @IsIn(PRIVACY_LEVELS, { message: `forest ${LEVEL_MESSAGE}` })
  forest?: PrivacyLevel;

  @ValidateIf(isSent('statistics'))
  @IsIn(PRIVACY_LEVELS, { message: `statistics ${LEVEL_MESSAGE}` })
  statistics?: PrivacyLevel;

  @ValidateIf(isSent('badges'))
  @IsIn(PRIVACY_LEVELS, { message: `badges ${LEVEL_MESSAGE}` })
  badges?: PrivacyLevel;

  @ValidateIf(isSent('currentTree'))
  @IsIn(PRIVACY_LEVELS, { message: `currentTree ${LEVEL_MESSAGE}` })
  currentTree?: PrivacyLevel;

  /** A5.8: appear on leaderboards (opt-in). */
  @ValidateIf(isSent('leaderboards'))
  @IsBoolean({ message: 'leaderboards must be true or false.' })
  leaderboards?: boolean;
}

/** A5.2: `?target=forest|tree:YYYY-MM|badge:<id>`, checked by `parseReactionTarget`. */
export class ReactionTargetQuery {
  @IsString({ message: 'target must be text.' })
  @MaxLength(128, { message: 'target is too long.' })
  target!: string;
}
