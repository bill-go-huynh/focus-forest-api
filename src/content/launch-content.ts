import type { ContentPack, PackBadge, PackTheme } from './content-pack.js';

/**
 * The Phase 5 launch content (owner decision, 2026-10-11: seed it with the project's defaults).
 *
 * - **Events:** the Autumn Study Event (four weeks, a board with two teams, a Community Tree) and
 *   the New Year Challenge (two weeks). Every milestone can be reached without Focus Together.
 * - **Community Tree:** a tenth of the spec's example thresholds (§12), for a small first audience.
 * - **Seasons:** meteorological seasons for each hemisphere, September 2026 to December 2027, so
 *   October is autumn in the north and spring in the south (docs/03 §10). Each theme's limited
 *   badge needs ten active days in about thirteen weeks.
 *
 * Windows are UTC. Badges stay acquirable two weeks after their content ends, so a reward reached
 * on the last day is still granted on the next read.
 */

const GRACE = 14;

const day = (iso: string, plusDays = 0) =>
  new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + plusDays * 86_400_000).toISOString();

const badge = (
  id: string,
  name: string,
  description: string,
  rarity: PackBadge['rarity'],
  source: PackBadge['source'],
  window: { from: string; until: string },
): PackBadge => ({
  id,
  name,
  description,
  rarity,
  source,
  availableFrom: day(window.from),
  availableUntil: day(window.until, GRACE),
});

const AUTUMN_STUDY = { from: '2026-10-19', until: '2026-11-16' };
const NEW_YEAR = { from: '2027-01-01', until: '2027-01-15' };

type Season = 'spring' | 'summer' | 'autumn' | 'winter';
const ENVIRONMENT: Record<Season, string> = {
  spring: 'sakura',
  summer: 'summer',
  autumn: 'autumn',
  winter: 'winter',
};
const NAME: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
};
const DESCRIPTION: Record<Season, string> = {
  spring: 'Cherry blossoms drift through the forest on a soft breeze.',
  summer: 'Long, bright days over a deep green forest.',
  autumn: 'Warm leaves fall quietly around your trees.',
  winter: 'Snow settles softly over a sleeping forest.',
};

/** [season, hemisphere, start, end, the year in its badge's name]. */
const SEASONS: [Season, 'north' | 'south', string, string, string][] = [
  ['autumn', 'north', '2026-09-01', '2026-12-01', '2026'],
  ['winter', 'north', '2026-12-01', '2027-03-01', '2026–27'],
  ['spring', 'north', '2027-03-01', '2027-06-01', '2027'],
  ['summer', 'north', '2027-06-01', '2027-09-01', '2027'],
  ['autumn', 'north', '2027-09-01', '2027-12-01', '2027'],
  ['spring', 'south', '2026-09-01', '2026-12-01', '2026'],
  ['summer', 'south', '2026-12-01', '2027-03-01', '2026–27'],
  ['autumn', 'south', '2027-03-01', '2027-06-01', '2027'],
  ['winter', 'south', '2027-06-01', '2027-09-01', '2027'],
  ['spring', 'south', '2027-09-01', '2027-12-01', '2027'],
];

const themeId = ([season, hemisphere, from]: (typeof SEASONS)[number]) =>
  `${season}-${from.slice(0, 4)}-${hemisphere}`;

const seasonBadges: PackBadge[] = SEASONS.map((entry) => {
  const [season, , from, until, year] = entry;
  return badge(
    `season:${themeId(entry)}`,
    `${NAME[season]} ${year}`,
    `Focused on ten days of ${season} ${year}.`,
    'common',
    'season',
    { from, until },
  );
});

const themes: PackTheme[] = SEASONS.map((entry) => {
  const [season, hemisphere, from, until] = entry;
  return {
    id: themeId(entry),
    name: NAME[season],
    description: DESCRIPTION[season],
    environmentId: ENVIRONMENT[season],
    hemisphere,
    startsAt: day(from),
    endsAt: day(until),
    rewards: [{ id: 'ten-days', badgeId: `season:${themeId(entry)}`, requiredActiveDays: 10 }],
  };
});

export const LAUNCH_CONTENT: ContentPack = {
  badges: [
    badge(
      'autumn-study-2026:steady',
      'Steady Learner',
      'Completed two missions of the Autumn Study Event 2026.',
      'common',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'autumn-study-2026:devoted',
      'Devoted Learner',
      'Completed four missions of the Autumn Study Event 2026.',
      'rare',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'autumn-study-2026:seedling',
      'Study Oak Seedling',
      'Helped the Study Oak sprout in autumn 2026.',
      'common',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'autumn-study-2026:growing-tree',
      'Study Oak Sapling',
      'Helped the Study Oak grow into a young tree in autumn 2026.',
      'common',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'autumn-study-2026:bloom',
      'Study Oak in Bloom',
      'Helped the Study Oak bloom in autumn 2026.',
      'rare',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'autumn-study-2026:final-form',
      'The Great Study Oak',
      'Helped the Study Oak reach its final form in autumn 2026.',
      'legendary',
      'event',
      AUTUMN_STUDY,
    ),
    badge(
      'new-year-2027:fresh-start',
      'Fresh Start 2027',
      'Started 2027 with a steady rhythm in the New Year Challenge.',
      'common',
      'event',
      NEW_YEAR,
    ),
    ...seasonBadges,
  ],
  events: [
    {
      id: 'autumn-study-2026',
      name: 'Autumn Study Event',
      description:
        'Four weeks of steady autumn focus. Every minute you focus also helps the Study Oak grow for everyone.',
      artworkId: 'autumn-study',
      startsAt: day(AUTUMN_STUDY.from),
      endsAt: day(AUTUMN_STUDY.until),
      entryMinSessions: 0,
      leaderboard: true,
      teams: [
        { id: 'maple', name: 'Maple' },
        { id: 'oak', name: 'Oak' },
      ],
      missions: [
        {
          id: 'five-hours',
          measure: 'focus_minutes',
          target: 300,
          dailyMinutes: 0,
          name: 'Focus 5 hours',
          description: 'Five hours of focus during the event.',
        },
        {
          id: 'ten-days',
          measure: 'active_days',
          target: 10,
          dailyMinutes: 0,
          name: 'Focus on 10 days',
          description: 'Focus on ten different days.',
        },
        {
          id: 'twenty-sessions',
          measure: 'sessions',
          target: 20,
          dailyMinutes: 0,
          name: 'Complete 20 sessions',
          description: 'Twenty completed focus sessions.',
        },
        {
          id: 'week-streak',
          measure: 'streak_days',
          target: 7,
          dailyMinutes: 0,
          name: 'Reach a 7-day streak',
          description: 'A streak of seven days. Rest days keep it.',
        },
        {
          id: 'focus-together',
          measure: 'focus_together_sessions',
          target: 3,
          dailyMinutes: 0,
          name: 'Focus together 3 times',
          description: 'Three Focus Together sessions.',
        },
      ],
      milestones: [
        {
          id: 'steady',
          name: 'Steady Learner',
          requiredMissions: 2,
          badgeId: 'autumn-study-2026:steady',
          trait: false,
        },
        {
          id: 'devoted',
          name: 'Devoted Learner',
          requiredMissions: 4,
          badgeId: 'autumn-study-2026:devoted',
          trait: true,
        },
      ],
      communityTree: {
        name: 'The Study Oak',
        artworkId: 'study-oak',
        milestones: [
          { stage: 'seedling', thresholdMinutes: 10_000, badgeId: 'autumn-study-2026:seedling' },
          {
            stage: 'growing_tree',
            thresholdMinutes: 50_000,
            badgeId: 'autumn-study-2026:growing-tree',
          },
          { stage: 'bloom', thresholdMinutes: 100_000, badgeId: 'autumn-study-2026:bloom' },
          {
            stage: 'final_form',
            thresholdMinutes: 500_000,
            badgeId: 'autumn-study-2026:final-form',
          },
        ],
      },
    },
    {
      id: 'new-year-2027',
      name: 'New Year Challenge',
      description: 'Two weeks to start the year with a steady, gentle rhythm.',
      artworkId: 'new-year',
      startsAt: day(NEW_YEAR.from),
      endsAt: day(NEW_YEAR.until),
      entryMinSessions: 0,
      leaderboard: false,
      teams: [],
      missions: [
        {
          id: 'ten-days',
          measure: 'active_days',
          target: 10,
          dailyMinutes: 15,
          name: 'Focus 15 minutes on 10 days',
          description: 'At least fifteen minutes of focus on ten different days.',
        },
        {
          id: 'week-streak',
          measure: 'streak_days',
          target: 7,
          dailyMinutes: 0,
          name: 'Reach a 7-day streak',
          description: 'A streak of seven days. Rest days keep it.',
        },
        {
          id: 'fourteen-sessions',
          measure: 'sessions',
          target: 14,
          dailyMinutes: 0,
          name: 'Complete 14 sessions',
          description: 'Fourteen completed focus sessions.',
        },
      ],
      milestones: [
        {
          id: 'fresh-start',
          name: 'Fresh Start',
          requiredMissions: 2,
          badgeId: 'new-year-2027:fresh-start',
          trait: true,
        },
      ],
      communityTree: null,
    },
  ],
  themes,
};
