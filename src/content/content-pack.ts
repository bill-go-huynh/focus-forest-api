import type {
  CommunityStage,
  ContentRarity,
  EventMissionMeasure,
  Hemisphere,
} from '../generated/prisma/enums.js';

/**
 * A content pack: events (missions, milestones, teams, a Community Tree), seasonal themes, and the
 * limited badges they reward, as the owner schedules them. Packs are applied by
 * `npm run content:seed`, never by a migration, so a test database holds no dated content unless
 * a test adds it. Until the admin content tools (Phase 19), a pack is how content goes live.
 *
 * Rewards are badges: every app version draws a badge from its category and rarity, whereas a new
 * cosmetic would equip as nothing until its art ships (docs/10).
 */

export interface PackBadge {
  /** `<content id>:<name>`; the artwork id is the same with `-` for `:`. */
  id: string;
  name: string;
  description: string;
  rarity: ContentRarity;
  source: 'event' | 'season';
  /** Acquirable from the content's start through a grace after its end. */
  availableFrom: string;
  availableUntil: string;
}

export interface PackEvent {
  id: string;
  name: string;
  description: string;
  artworkId: string;
  startsAt: string;
  endsAt: string;
  entryMinSessions: number;
  leaderboard: boolean;
  /** Only on events with a board. */
  teams: { id: string; name: string }[];
  missions: {
    id: string;
    measure: EventMissionMeasure;
    target: number;
    /** Only for `active_days`; 0 means any counted session. */
    dailyMinutes: number;
    name: string;
    description: string;
  }[];
  milestones: {
    id: string;
    name: string;
    requiredMissions: number;
    badgeId: string | null;
    /** The event trait `event:<event id>` on the tree growing when it is reached. */
    trait: boolean;
  }[];
  communityTree: {
    name: string;
    artworkId: string;
    milestones: { stage: CommunityStage; thresholdMinutes: number; badgeId: string }[];
  } | null;
}

export interface PackTheme {
  id: string;
  name: string;
  description: string;
  environmentId: string;
  /** null: both hemispheres. */
  hemisphere: Hemisphere | null;
  startsAt: string;
  endsAt: string;
  rewards: { id: string; badgeId: string; requiredActiveDays: number }[];
}

export interface ContentPack {
  badges: PackBadge[];
  events: PackEvent[];
  themes: PackTheme[];
}

/**
 * The seasonal art sets focus-forest-mobile draws (`src/tree/SeasonalOverlay.tsx`); any other id
 * draws nothing, so a pack may not schedule one.
 */
export const KNOWN_SEASONAL_ENVIRONMENTS = [
  'autumn',
  'winter',
  'sakura',
  'rain',
  'night',
  'summer',
] as const;

/** A reward reached at the very end is granted on the next read, so badges outlive their content. */
export const GRACE_DAYS = 7;

const DAY = 86_400_000;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BADGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;
const STAGES: readonly CommunityStage[] = ['seedling', 'growing_tree', 'bloom', 'final_form'];

const time = (iso: string) => new Date(iso).getTime();

function duplicates(ids: readonly string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/** Every reason the database or the product would refuse this pack; empty when it is valid. */
export function contentPackProblems(pack: ContentPack): string[] {
  const problems: string[] = [];
  const badges = new Map(pack.badges.map((badge) => [badge.id, badge]));

  const ids = (kind: string, list: readonly string[], pattern = SLUG) => {
    for (const id of list)
      if (!pattern.test(id)) problems.push(`${kind} id "${id}" is not a slug.`);
    for (const id of duplicates(list)) problems.push(`${kind} id "${id}" is used twice.`);
  };
  const window = (kind: string, id: string, startsAt: string, endsAt: string) => {
    if (!(time(startsAt) < time(endsAt))) problems.push(`${kind} ${id} ends before it starts.`);
  };
  /** The badge exists, comes from this content, and is acquirable over its window and grace. */
  const reward = (
    badgeId: string,
    source: PackBadge['source'],
    content: { id: string; startsAt: string; endsAt: string },
  ) => {
    const badge = badges.get(badgeId);
    if (!badge) {
      problems.push(`${content.id} rewards the badge ${badgeId}, which the pack does not define.`);
      return;
    }
    if (badge.source !== source) {
      problems.push(
        `The badge ${badgeId} rewards ${source} content but its source is ${badge.source}.`,
      );
    }
    if (
      time(badge.availableFrom) > time(content.startsAt) ||
      time(badge.availableUntil) < time(content.endsAt) + GRACE_DAYS * DAY
    ) {
      problems.push(
        `The badge ${badgeId} must be acquirable from ${content.id}'s start through a grace of ${GRACE_DAYS} days after its end.`,
      );
    }
  };

  ids(
    'Badge',
    pack.badges.map((badge) => badge.id),
    BADGE_ID,
  );
  for (const badge of pack.badges) {
    window('The badge', badge.id, badge.availableFrom, badge.availableUntil);
  }

  ids(
    'Event',
    pack.events.map((event) => event.id),
  );
  for (const event of pack.events) {
    window('The event', event.id, event.startsAt, event.endsAt);
    if (event.entryMinSessions < 0) {
      problems.push(`The event ${event.id} needs a non-negative entry condition.`);
    }

    ids(
      `${event.id} team`,
      event.teams.map((team) => team.id),
    );
    if (!event.leaderboard) {
      for (const team of event.teams) {
        problems.push(`${event.id} has the team ${team.id} but no board.`);
      }
    }

    ids(
      `${event.id} mission`,
      event.missions.map((mission) => mission.id),
    );
    for (const mission of event.missions) {
      if (mission.target < 1) problems.push(`${event.id} mission ${mission.id} needs a target.`);
      if (
        mission.dailyMinutes < 0 ||
        (mission.measure !== 'active_days' && mission.dailyMinutes !== 0)
      ) {
        problems.push(`${event.id} mission ${mission.id}: daily minutes are for active days only.`);
      }
    }

    ids(
      `${event.id} milestone`,
      event.milestones.map((milestone) => milestone.id),
    );
    for (const milestone of event.milestones) {
      if (milestone.requiredMissions < 1 || milestone.requiredMissions > event.missions.length) {
        problems.push(
          `${event.id} milestone ${milestone.id} needs between 1 and ${event.missions.length} missions.`,
        );
      }
      if (!milestone.badgeId && !milestone.trait) {
        problems.push(`${event.id} milestone ${milestone.id} rewards nothing.`);
      }
      if (milestone.badgeId) reward(milestone.badgeId, 'event', event);
    }

    const tree = event.communityTree;
    if (tree) {
      tree.milestones.forEach((milestone, i) => {
        const before = tree.milestones[i - 1];
        if (
          before &&
          (STAGES.indexOf(milestone.stage) <= STAGES.indexOf(before.stage) ||
            milestone.thresholdMinutes <= before.thresholdMinutes)
        ) {
          problems.push(
            `${event.id}: Community Tree stages must rise in order and threshold (${before.stage} ${before.thresholdMinutes} → ${milestone.stage} ${milestone.thresholdMinutes}).`,
          );
        }
        if (milestone.thresholdMinutes < 1) {
          problems.push(`${event.id}: the ${milestone.stage} stage needs a threshold.`);
        }
        reward(milestone.badgeId, 'event', event);
      });
    }
  }

  ids(
    'Theme',
    pack.themes.map((theme) => theme.id),
  );
  for (const theme of pack.themes) {
    window('The theme', theme.id, theme.startsAt, theme.endsAt);
    if (!(KNOWN_SEASONAL_ENVIRONMENTS as readonly string[]).includes(theme.environmentId)) {
      problems.push(
        `The theme ${theme.id} uses "${theme.environmentId}", which the app cannot draw.`,
      );
    }
    const days = Math.ceil((time(theme.endsAt) - time(theme.startsAt)) / DAY);
    ids(
      `${theme.id} reward`,
      theme.rewards.map((r) => r.id),
    );
    for (const r of theme.rewards) {
      if (r.requiredActiveDays < 1 || r.requiredActiveDays > days) {
        problems.push(`${theme.id} reward ${r.id} needs between 1 and ${days} active days.`);
      }
      reward(r.badgeId, 'season', theme);
    }
  }

  // One theme at a time for each person: the API shows the first, so a second would never show.
  pack.themes.forEach((theme, i) => {
    for (const other of pack.themes.slice(0, i)) {
      const samePeople =
        theme.hemisphere === null ||
        other.hemisphere === null ||
        theme.hemisphere === other.hemisphere;
      const overlap =
        time(theme.startsAt) < time(other.endsAt) && time(other.startsAt) < time(theme.endsAt);
      if (samePeople && overlap) problems.push(`The theme ${theme.id} overlaps ${other.id}.`);
    }
  });

  return problems;
}
