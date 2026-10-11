import type { BadgeDto, CosmeticDto } from '../progression/badge.dto.js';
import type { CommunityTreeSummary, SessionCommunityResult } from './community-tree.dto.js';
import type { EventPhase, MissionMeasure } from './event-rules.js';

/** One event as the user sees it. Mission values appear once they joined. */
export interface EventDto {
  id: string;
  name: string;
  description: string;
  artworkId: string;
  phase: EventPhase;
  startsAt: string;
  /** Shown as information ("Ends in 3 days"), never as pressure (docs/02). */
  endsAt: string;
  joined: boolean;
  /** A5.7: the event's shared tree, or null when it has none. */
  communityTree: CommunityTreeSummary | null;
  missions: {
    id: string;
    name: string;
    description: string;
    measure: MissionMeasure;
    target: number;
    dailyMinutes: number;
    /** Null until joined. */
    value: number | null;
    completed: boolean;
  }[];
  milestones: {
    id: string;
    name: string;
    requiredMissions: number;
    reached: boolean;
    rewards: { badge: BadgeDto | null; cosmetic: CosmeticDto | null; traitId: string | null };
  }[];
}

/** What one session did for a joined event (the completion screen's one line, docs/02). */
export interface SessionEventResult {
  eventId: string;
  missions: { id: string; value: number; target: number; completed: boolean }[];
  newlyCompletedMissionIds: string[];
  newlyReachedMilestoneIds: string[];
  /** A5.7: what the session added to the event's Community Tree; null without one. */
  community: SessionCommunityResult | null;
}

/** Home's one quiet event card. */
export interface EventCardDto {
  id: string;
  name: string;
  artworkId: string;
  phase: EventPhase;
  startsAt: string;
  endsAt: string;
  joined: boolean;
  /** Null until joined. */
  missionsCompleted: number | null;
  missionsTotal: number;
}

/** A stored session event result, checked when read back. Null before A5.6. */
export function parseEventResult(value: unknown): SessionEventResult[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error('Invalid event result.');
  // Results stored before A5.7 have no Community Tree line.
  return (value as SessionEventResult[]).map((entry) => ({
    ...entry,
    community: entry.community ?? null,
  }));
}
