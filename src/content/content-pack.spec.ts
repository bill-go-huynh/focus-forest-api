import {
  type ContentPack,
  contentPackProblems,
  KNOWN_SEASONAL_ENVIRONMENTS,
} from './content-pack.js';
import { LAUNCH_CONTENT } from './launch-content.js';

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso).getTime();

/** A small valid pack: one theme and its badge. */
function pack(): ContentPack {
  return {
    badges: [
      {
        id: 'season:spring-2027-north',
        name: 'Spring 2027',
        description: 'Ten days of focus in spring.',
        rarity: 'common',
        source: 'season',
        availableFrom: '2027-03-01T00:00:00.000Z',
        availableUntil: '2027-06-15T00:00:00.000Z',
      },
    ],
    themes: [
      {
        id: 'spring-2027-north',
        name: 'Spring',
        description: 'Blossoms.',
        environmentId: 'sakura',
        hemisphere: 'north',
        startsAt: '2027-03-01T00:00:00.000Z',
        endsAt: '2027-06-01T00:00:00.000Z',
        rewards: [{ id: 'ten-days', badgeId: 'season:spring-2027-north', requiredActiveDays: 10 }],
      },
    ],
  };
}

/** The problems of `pack()` after `change`. */
function problemsAfter(change: (p: ContentPack) => void): string[] {
  const p = pack();
  change(p);
  return contentPackProblems(p);
}

describe('content pack checks', () => {
  it('accepts a valid pack', () => {
    expect(contentPackProblems(pack())).toEqual([]);
  });

  it('refuses ids that are not slugs, and duplicate ids', () => {
    expect(problemsAfter((p) => (p.themes[0]!.id = 'Spring North'))).toContainEqual(
      expect.stringContaining('Spring North'),
    );
    expect(problemsAfter((p) => (p.themes[0]!.rewards[0]!.id = 'ten_days'))).toContainEqual(
      expect.stringContaining('ten_days'),
    );
    expect(problemsAfter((p) => (p.badges[0]!.id = 'a:b:c'))).toContainEqual(
      expect.stringContaining('a:b:c'),
    );
    expect(problemsAfter((p) => p.badges.push({ ...p.badges[0]! }))).toContainEqual(
      expect.stringContaining('season:spring-2027-north'),
    );
    expect(
      problemsAfter((p) => p.themes[0]!.rewards.push({ ...p.themes[0]!.rewards[0]! })),
    ).toContainEqual(expect.stringContaining('ten-days'));
  });

  it('refuses a window that ends before it starts', () => {
    expect(
      problemsAfter((p) => (p.badges[0]!.availableUntil = p.badges[0]!.availableFrom)),
    ).toContainEqual(expect.stringContaining('season:spring-2027-north'));
    expect(problemsAfter((p) => (p.themes[0]!.endsAt = '2027-02-01T00:00:00.000Z'))).toContainEqual(
      expect.stringContaining('spring-2027-north'),
    );
  });

  it('refuses a reward that names a badge the pack does not define', () => {
    expect(
      problemsAfter((p) => (p.themes[0]!.rewards[0]!.badgeId = 'season:missing')),
    ).toContainEqual(expect.stringContaining('season:missing'));
  });

  it('refuses a badge whose source is not its content', () => {
    const p = pack();
    const known = new Map([
      ['focus-hours:10', { source: 'achievement', availableFrom: null, availableUntil: null }],
    ]);
    p.themes[0]!.rewards[0]!.badgeId = 'focus-hours:10';
    expect(contentPackProblems(p, known)).toContainEqual(expect.stringContaining('focus-hours:10'));
  });

  it('refuses a badge that is not acquirable for the whole window', () => {
    expect(
      problemsAfter((p) => (p.badges[0]!.availableFrom = '2027-03-02T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('season:spring-2027-north'));
    expect(
      problemsAfter((p) => (p.badges[0]!.availableUntil = '2027-05-31T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('season:spring-2027-north'));
  });

  it('refuses a badge with no grace after its content ends', () => {
    // Rewards reached at the very end are still granted on the next read (A5.9).
    expect(
      problemsAfter((p) => (p.badges[0]!.availableUntil = '2027-06-01T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('grace'));
  });

  it('refuses a theme the app cannot draw', () => {
    expect(problemsAfter((p) => (p.themes[0]!.environmentId = 'fireworks'))).toContainEqual(
      expect.stringContaining('fireworks'),
    );
  });

  it('refuses a reward that needs more days than its window has', () => {
    expect(problemsAfter((p) => (p.themes[0]!.rewards[0]!.requiredActiveDays = 93))).toContainEqual(
      expect.stringContaining('ten-days'),
    );
    expect(problemsAfter((p) => (p.themes[0]!.rewards[0]!.requiredActiveDays = 0))).toContainEqual(
      expect.stringContaining('ten-days'),
    );
  });

  it('refuses two themes holding at once for the same people', () => {
    const second = (hemisphere: 'north' | 'south' | null, startsAt: string) => (p: ContentPack) =>
      p.themes.push({
        ...p.themes[0]!,
        id: 'rain-2027',
        environmentId: 'rain',
        hemisphere,
        startsAt,
        endsAt: '2027-07-01T00:00:00.000Z',
        rewards: [],
      });
    expect(problemsAfter(second('north', '2027-05-01T00:00:00.000Z'))).toContainEqual(
      expect.stringContaining('rain-2027'),
    );
    // A theme for both hemispheres overlaps the northern one.
    expect(problemsAfter(second(null, '2027-05-01T00:00:00.000Z'))).toContainEqual(
      expect.stringContaining('rain-2027'),
    );
    expect(problemsAfter(second('south', '2027-05-01T00:00:00.000Z'))).toEqual([]);
    expect(problemsAfter(second('north', '2027-06-01T00:00:00.000Z'))).toEqual([]);
  });
});

describe('launch content (Phase 5)', () => {
  it('passes every check', () => {
    expect(contentPackProblems(LAUNCH_CONTENT)).toEqual([]);
  });

  it('gives each hemisphere one theme at a time, without gaps, from September 2026 to December 2027', () => {
    for (const hemisphere of ['north', 'south'] as const) {
      const themes = LAUNCH_CONTENT.themes
        .filter((theme) => theme.hemisphere === hemisphere || theme.hemisphere === null)
        .sort((a, b) => at(a.startsAt) - at(b.startsAt));
      expect(themes[0]!.startsAt).toBe('2026-09-01T00:00:00.000Z');
      expect(themes.at(-1)!.endsAt).toBe('2027-12-01T00:00:00.000Z');
      themes.slice(1).forEach((theme, i) => expect(theme.startsAt).toBe(themes[i]!.endsAt));
    }
  });

  it('follows each hemisphere’s seasons: October is autumn in the north and spring in the south', () => {
    const holding = (hemisphere: 'north' | 'south', iso: string) =>
      LAUNCH_CONTENT.themes.find(
        (theme) =>
          (theme.hemisphere === hemisphere || theme.hemisphere === null) &&
          at(theme.startsAt) <= at(iso) &&
          at(iso) < at(theme.endsAt),
      )?.environmentId;
    expect(holding('north', '2026-10-15T00:00:00.000Z')).toBe('autumn');
    expect(holding('south', '2026-10-15T00:00:00.000Z')).toBe('sakura');
    expect(holding('north', '2027-01-15T00:00:00.000Z')).toBe('winter');
    expect(holding('south', '2027-01-15T00:00:00.000Z')).toBe('summer');
    expect(holding('north', '2027-07-15T00:00:00.000Z')).toBe('summer');
    expect(holding('south', '2027-07-15T00:00:00.000Z')).toBe('winter');
  });

  it('draws only the environments the app knows', () => {
    for (const theme of LAUNCH_CONTENT.themes) {
      expect(KNOWN_SEASONAL_ENVIRONMENTS).toContain(theme.environmentId);
    }
  });

  it('asks for gentle seasonal effort: a few days a month, never daily', () => {
    for (const theme of LAUNCH_CONTENT.themes) {
      const days = (at(theme.endsAt) - at(theme.startsAt)) / DAY;
      for (const reward of theme.rewards) {
        expect(reward.requiredActiveDays).toBeLessThanOrEqual(days / 4);
      }
    }
  });

  it('rewards with badges only, which every app version can draw', () => {
    // A new cosmetic would equip as nothing until its art ships (docs/10).
    const seasons = LAUNCH_CONTENT.themes.flatMap((theme) => theme.rewards.map((r) => r.badgeId));
    const defined = new Set(LAUNCH_CONTENT.badges.map((badge) => badge.id));
    for (const id of seasons) expect(defined.has(id)).toBe(true);
  });

  it('holds no events or Community Tree (owner, 2026-10-22)', () => {
    expect(Object.keys(LAUNCH_CONTENT).sort()).toEqual(['badges', 'themes']);
    for (const badge of LAUNCH_CONTENT.badges) expect(badge.source).toBe('season');
  });
});
