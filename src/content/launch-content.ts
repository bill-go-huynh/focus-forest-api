import type { ContentPack, PackBadge, PackTheme } from './content-pack.js';

/**
 * The Phase 5 launch content (owner decision, 2026-10-11: seed it with the project's defaults).
 *
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
  badges: seasonBadges,
  themes,
};
