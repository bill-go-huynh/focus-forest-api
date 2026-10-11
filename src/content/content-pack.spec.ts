import {
  type ContentPack,
  contentPackProblems,
  KNOWN_SEASONAL_ENVIRONMENTS,
} from './content-pack.js';
import { LAUNCH_CONTENT } from './launch-content.js';

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso).getTime();

/** A small valid pack: one event with a Community Tree, and one theme. */
function pack(): ContentPack {
  return {
    badges: [
      {
        id: 'spring-sprint:steady',
        name: 'Steady',
        description: 'Two missions of the Spring Sprint.',
        rarity: 'common',
        source: 'event',
        availableFrom: '2027-04-01T00:00:00.000Z',
        availableUntil: '2027-04-22T00:00:00.000Z',
      },
      {
        id: 'spring-sprint:seedling',
        name: 'Seedling',
        description: 'The Spring Sprint tree sprouted.',
        rarity: 'common',
        source: 'event',
        availableFrom: '2027-04-01T00:00:00.000Z',
        availableUntil: '2027-04-22T00:00:00.000Z',
      },
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
    events: [
      {
        id: 'spring-sprint',
        name: 'Spring Sprint',
        description: 'One week of focus.',
        artworkId: 'spring-sprint',
        startsAt: '2027-04-01T00:00:00.000Z',
        endsAt: '2027-04-08T00:00:00.000Z',
        entryMinSessions: 0,
        leaderboard: false,
        teams: [],
        missions: [
          {
            id: 'two-hours',
            measure: 'focus_minutes',
            target: 120,
            dailyMinutes: 0,
            name: 'Focus 2 hours',
            description: 'Two hours.',
          },
          {
            id: 'five-days',
            measure: 'active_days',
            target: 5,
            dailyMinutes: 15,
            name: 'Focus on 5 days',
            description: 'Five days.',
          },
        ],
        milestones: [
          {
            id: 'steady',
            name: 'Steady',
            requiredMissions: 2,
            badgeId: 'spring-sprint:steady',
            trait: true,
          },
        ],
        communityTree: {
          name: 'The Sprint Oak',
          artworkId: 'sprint-oak',
          milestones: [
            { stage: 'seedling', thresholdMinutes: 1000, badgeId: 'spring-sprint:seedling' },
          ],
        },
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
    expect(problemsAfter((p) => (p.events[0]!.id = 'Spring Sprint'))).toContainEqual(
      expect.stringContaining('Spring Sprint'),
    );
    expect(problemsAfter((p) => (p.themes[0]!.rewards[0]!.id = 'ten_days'))).toContainEqual(
      expect.stringContaining('ten_days'),
    );
    expect(problemsAfter((p) => (p.badges[0]!.id = 'a:b:c'))).toContainEqual(
      expect.stringContaining('a:b:c'),
    );
    expect(problemsAfter((p) => p.badges.push({ ...p.badges[0]! }))).toContainEqual(
      expect.stringContaining('spring-sprint:steady'),
    );
    expect(
      problemsAfter((p) => p.events[0]!.missions.push({ ...p.events[0]!.missions[0]! })),
    ).toContainEqual(expect.stringContaining('two-hours'));
  });

  it('refuses a window that ends before it starts', () => {
    expect(problemsAfter((p) => (p.events[0]!.endsAt = p.events[0]!.startsAt))).toContainEqual(
      expect.stringContaining('spring-sprint'),
    );
    expect(problemsAfter((p) => (p.themes[0]!.endsAt = '2027-02-01T00:00:00.000Z'))).toContainEqual(
      expect.stringContaining('spring-2027-north'),
    );
  });

  it('refuses a reward that names a badge the pack does not define', () => {
    expect(
      problemsAfter((p) => (p.events[0]!.milestones[0]!.badgeId = 'spring-sprint:missing')),
    ).toContainEqual(expect.stringContaining('spring-sprint:missing'));
    expect(
      problemsAfter((p) => (p.themes[0]!.rewards[0]!.badgeId = 'season:missing')),
    ).toContainEqual(expect.stringContaining('season:missing'));
    expect(
      problemsAfter(
        (p) => (p.events[0]!.communityTree!.milestones[0]!.badgeId = 'spring-sprint:none'),
      ),
    ).toContainEqual(expect.stringContaining('spring-sprint:none'));
  });

  it('refuses a badge whose source is not its content', () => {
    expect(problemsAfter((p) => (p.badges[0]!.source = 'season'))).toContainEqual(
      expect.stringContaining('spring-sprint:steady'),
    );
    expect(problemsAfter((p) => (p.badges[2]!.source = 'event'))).toContainEqual(
      expect.stringContaining('season:spring-2027-north'),
    );
  });

  it('refuses a badge that is not acquirable for the whole window', () => {
    expect(
      problemsAfter((p) => (p.badges[0]!.availableFrom = '2027-04-02T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('spring-sprint:steady'));
    expect(
      problemsAfter((p) => (p.badges[0]!.availableUntil = '2027-04-07T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('spring-sprint:steady'));
    expect(
      problemsAfter((p) => (p.badges[2]!.availableUntil = '2027-05-31T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('season:spring-2027-north'));
  });

  it('refuses a badge with no grace after its content ends', () => {
    // Rewards reached at the very end are still granted on the next read (A5.6, A5.7, A5.9).
    expect(
      problemsAfter((p) => (p.badges[0]!.availableUntil = '2027-04-08T00:00:00.000Z')),
    ).toContainEqual(expect.stringContaining('grace'));
  });

  it('refuses mission terms the database refuses', () => {
    expect(problemsAfter((p) => (p.events[0]!.missions[0]!.target = 0))).toContainEqual(
      expect.stringContaining('two-hours'),
    );
    expect(problemsAfter((p) => (p.events[0]!.missions[0]!.dailyMinutes = 10))).toContainEqual(
      expect.stringContaining('two-hours'),
    );
    expect(problemsAfter((p) => (p.events[0]!.entryMinSessions = -1))).toContainEqual(
      expect.stringContaining('spring-sprint'),
    );
  });

  it('refuses a milestone nobody can reach, or with no reward', () => {
    expect(problemsAfter((p) => (p.events[0]!.milestones[0]!.requiredMissions = 3))).toContainEqual(
      expect.stringContaining('steady'),
    );
    expect(problemsAfter((p) => (p.events[0]!.milestones[0]!.requiredMissions = 0))).toContainEqual(
      expect.stringContaining('steady'),
    );
    expect(
      problemsAfter((p) => {
        p.events[0]!.milestones[0]!.badgeId = null;
        p.events[0]!.milestones[0]!.trait = false;
      }),
    ).toContainEqual(expect.stringContaining('steady'));
  });

  it('refuses a Community Tree whose stages are out of order or repeated', () => {
    const tree = (p: ContentPack) => p.events[0]!.communityTree!;
    expect(
      problemsAfter((p) =>
        tree(p).milestones.push({
          stage: 'bloom',
          thresholdMinutes: 500,
          badgeId: 'spring-sprint:seedling',
        }),
      ),
    ).toContainEqual(expect.stringContaining('bloom'));
    expect(
      problemsAfter((p) =>
        tree(p).milestones.unshift({
          stage: 'bloom',
          thresholdMinutes: 5000,
          badgeId: 'spring-sprint:seedling',
        }),
      ),
    ).toContainEqual(expect.stringContaining('bloom'));
    expect(
      problemsAfter((p) => tree(p).milestones.push({ ...tree(p).milestones[0]! })),
    ).toContainEqual(expect.stringContaining('seedling'));
    // A stage repeated with a higher threshold is still a repeated stage.
    expect(
      problemsAfter((p) =>
        tree(p).milestones.push({ ...tree(p).milestones[0]!, thresholdMinutes: 2000 }),
      ),
    ).toContainEqual(expect.stringContaining('seedling 2000'));
  });

  it('refuses teams on an event without a board', () => {
    expect(
      problemsAfter((p) => (p.events[0]!.teams = [{ id: 'maple', name: 'Maple' }])),
    ).toContainEqual(expect.stringContaining('maple'));
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

  it('lets someone who never focuses together reach every event milestone', () => {
    for (const event of LAUNCH_CONTENT.events) {
      const solo = event.missions.filter((m) => m.measure !== 'focus_together_sessions').length;
      for (const milestone of event.milestones) {
        expect(milestone.requiredMissions).toBeLessThanOrEqual(solo);
      }
    }
  });

  it('runs the Autumn Study Event with a board, two teams, and a Community Tree', () => {
    const autumn = LAUNCH_CONTENT.events.find((event) => event.id === 'autumn-study-2026')!;
    expect(autumn).toMatchObject({
      startsAt: '2026-10-19T00:00:00.000Z',
      endsAt: '2026-11-16T00:00:00.000Z',
      leaderboard: true,
      entryMinSessions: 0,
    });
    expect(autumn.teams.map((team) => team.id)).toEqual(['maple', 'oak']);
    expect(autumn.communityTree!.milestones.map((m) => m.stage)).toEqual([
      'seedling',
      'growing_tree',
      'bloom',
      'final_form',
    ]);
  });

  it('rewards with badges only, which every app version can draw', () => {
    // A new cosmetic would equip as nothing until its art ships (docs/10).
    const events = LAUNCH_CONTENT.events.flatMap((event) => [
      ...event.milestones.map((m) => m.badgeId),
      ...(event.communityTree?.milestones.map((m) => m.badgeId) ?? []),
    ]);
    const seasons = LAUNCH_CONTENT.themes.flatMap((theme) => theme.rewards.map((r) => r.badgeId));
    const defined = new Set(LAUNCH_CONTENT.badges.map((badge) => badge.id));
    for (const id of [...events, ...seasons]) if (id) expect(defined.has(id)).toBe(true);
  });
});
