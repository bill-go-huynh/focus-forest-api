import { applyContentPack } from '../../src/content/apply-content-pack.js';
import type { ContentPack } from '../../src/content/content-pack.js';
import { LAUNCH_CONTENT } from '../../src/content/launch-content.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * Content packs (`npm run content:seed`): the Phase 5 launch content (events, a Community Tree,
 * seasonal themes, and their badges) applied to a database outside the migrations, so dated
 * content never reaches a test database unasked. A pack only adds what is missing: rerunning it
 * changes nothing, and content the owner has since edited stays as edited.
 */

const t = new ConsistencyHarness('2026-10-25T10:00:00.000Z');
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

const counts = async () => ({
  badges: await t.prisma.badgeDefinition.count({ where: { source: { in: ['event', 'season'] } } }),
  events: await t.prisma.event.count(),
  missions: await t.prisma.eventMission.count(),
  milestones: await t.prisma.eventMilestone.count(),
  teams: await t.prisma.eventTeam.count(),
  communityTrees: await t.prisma.communityTree.count(),
  communityMilestones: await t.prisma.communityMilestone.count(),
  themes: await t.prisma.seasonalTheme.count(),
  seasonalRewards: await t.prisma.seasonalReward.count(),
});

const expected = {
  badges: LAUNCH_CONTENT.badges.length,
  events: LAUNCH_CONTENT.events.length,
  missions: LAUNCH_CONTENT.events.flatMap((e) => e.missions).length,
  milestones: LAUNCH_CONTENT.events.flatMap((e) => e.milestones).length,
  teams: LAUNCH_CONTENT.events.flatMap((e) => e.teams).length,
  communityTrees: LAUNCH_CONTENT.events.filter((e) => e.communityTree).length,
  communityMilestones: LAUNCH_CONTENT.events.flatMap((e) => e.communityTree?.milestones ?? [])
    .length,
  themes: LAUNCH_CONTENT.themes.length,
  seasonalRewards: LAUNCH_CONTENT.themes.flatMap((theme) => theme.rewards).length,
};

const get = async (user: User, path: string) =>
  (await t.http().get(path).set(user.auth).expect(200)).body as Body;

describe('content packs (C5)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(() => t.reset());

  it('adds the launch content, as the pack defines it', async () => {
    const result = await applyContentPack(t.prisma, LAUNCH_CONTENT);

    expect(result).toEqual({
      added: {
        badges: expected.badges,
        events: LAUNCH_CONTENT.events.map((e) => e.id),
        themes: LAUNCH_CONTENT.themes.map((theme) => theme.id),
      },
      kept: { badges: 0, events: [], themes: [] },
    });
    expect(await counts()).toEqual(expected);

    const badge = await t.prisma.badgeDefinition.findUniqueOrThrow({
      where: { id: 'autumn-study-2026:devoted' },
    });
    expect(badge).toMatchObject({
      category: 'event',
      source: 'event',
      availability: 'limited',
      status: 'active',
      artworkId: 'autumn-study-2026-devoted',
    });
    const devoted = await t.prisma.eventMilestone.findUniqueOrThrow({
      where: { eventId_id: { eventId: 'autumn-study-2026', id: 'devoted' } },
    });
    expect(devoted).toMatchObject({
      badgeId: 'autumn-study-2026:devoted',
      traitId: 'event:autumn-study-2026',
    });
    const theme = await t.prisma.seasonalTheme.findUniqueOrThrow({
      where: { id: 'spring-2026-south' },
      include: { rewards: true },
    });
    expect(theme).toMatchObject({
      hemisphere: 'south',
      environmentId: 'sakura',
      status: 'active',
      startsAt: new Date('2026-09-01T00:00:00.000Z'),
      endsAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(theme.rewards).toEqual([
      expect.objectContaining({ badgeId: 'season:spring-2026-south', cosmeticId: null }),
    ]);
  });

  it('changes nothing when run again', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    const result = await applyContentPack(t.prisma, LAUNCH_CONTENT);

    expect(result).toEqual({
      added: { badges: 0, events: [], themes: [] },
      kept: {
        badges: expected.badges,
        events: LAUNCH_CONTENT.events.map((e) => e.id),
        themes: LAUNCH_CONTENT.themes.map((theme) => theme.id),
      },
    });
    expect(await counts()).toEqual(expected);
  });

  it('keeps content the owner has edited since', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    await t.prisma.event.update({
      where: { id: 'autumn-study-2026' },
      data: { name: 'Autumn Reading Month' },
    });
    await t.prisma.eventMission.delete({
      where: { eventId_id: { eventId: 'autumn-study-2026', id: 'twenty-sessions' } },
    });
    await t.prisma.seasonalTheme.update({
      where: { id: 'autumn-2026-north' },
      data: { status: 'retired' },
    });

    await applyContentPack(t.prisma, LAUNCH_CONTENT);

    const autumn = await t.prisma.event.findUniqueOrThrow({
      where: { id: 'autumn-study-2026' },
      include: { missions: true },
    });
    expect(autumn.name).toBe('Autumn Reading Month');
    expect(autumn.missions.map((m) => m.id)).not.toContain('twenty-sessions');
    expect(
      (await t.prisma.seasonalTheme.findUniqueOrThrow({ where: { id: 'autumn-2026-north' } }))
        .status,
    ).toBe('retired');
  });

  it('adds a later pack’s new content next to what is there', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    const later: ContentPack = {
      badges: [
        {
          id: 'summer-deep-work-2027:deep',
          name: 'Deep Summer',
          description: 'Two missions of Summer Deep Work.',
          rarity: 'common',
          source: 'event',
          availableFrom: '2027-07-05T00:00:00.000Z',
          availableUntil: '2027-08-02T00:00:00.000Z',
        },
      ],
      events: [
        {
          id: 'summer-deep-work-2027',
          name: 'Summer Deep Work',
          description: 'Two weeks of longer sessions.',
          artworkId: 'summer-deep-work',
          startsAt: '2027-07-05T00:00:00.000Z',
          endsAt: '2027-07-19T00:00:00.000Z',
          entryMinSessions: 0,
          leaderboard: false,
          teams: [],
          missions: [
            {
              id: 'five-hours',
              measure: 'focus_minutes',
              target: 300,
              dailyMinutes: 0,
              name: 'Focus 5 hours',
              description: 'Five hours of focus.',
            },
            {
              id: 'ten-sessions',
              measure: 'sessions',
              target: 10,
              dailyMinutes: 0,
              name: 'Complete 10 sessions',
              description: 'Ten sessions.',
            },
          ],
          milestones: [
            {
              id: 'deep',
              name: 'Deep Summer',
              requiredMissions: 2,
              badgeId: 'summer-deep-work-2027:deep',
              trait: false,
            },
          ],
          communityTree: null,
        },
      ],
      themes: [],
    };

    const result = await applyContentPack(t.prisma, later);

    expect(result.added).toEqual({ badges: 1, events: ['summer-deep-work-2027'], themes: [] });
    expect(await t.prisma.event.count()).toBe(expected.events + 1);
  });

  it('refuses a pack with problems, and writes nothing', async () => {
    const broken: ContentPack = {
      ...LAUNCH_CONTENT,
      themes: LAUNCH_CONTENT.themes.map((theme, i) =>
        i === 0 ? { ...theme, environmentId: 'fireworks' } : theme,
      ),
    };

    await expect(applyContentPack(t.prisma, broken)).rejects.toThrow(/fireworks/);
    expect(await t.prisma.event.count()).toBe(0);
    expect(await t.prisma.badgeDefinition.count({ where: { source: 'season' } })).toBe(0);
  });

  it('is served by the API: events, the Community Tree, and each hemisphere’s season', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    const ana = await t.signUp('ana@example.com', 'Europe/Berlin');
    const ben = await t.signUp('ben@example.com', 'Australia/Sydney');

    const events = (await get(ana, '/events')) as { items: Body[] };
    expect(events.items.map((e) => [e['id'], e['phase']])).toEqual([
      ['autumn-study-2026', 'live'],
      ['new-year-2027', 'upcoming'],
    ]);
    await t.http().post('/events/autumn-study-2026/join').set(ana.auth).expect(200);
    const autumn = await get(ana, '/events/autumn-study-2026');
    expect(autumn).toMatchObject({ joined: true, phase: 'live' });
    expect((autumn['missions'] as Body[]).map((m) => m['id'])).toEqual([
      'five-hours',
      'ten-days',
      'twenty-sessions',
      'week-streak',
      'focus-together',
    ]);
    expect(
      await t.prisma.eventParticipation.findFirstOrThrow({ where: { userId: ana.userId } }),
    ).toMatchObject({ teamId: 'maple' });

    const tree = await get(ana, '/events/autumn-study-2026/community-tree');
    expect(tree).toMatchObject({ name: 'The Study Oak', stage: null, joined: true });
    expect((tree['milestones'] as Body[]).map((m) => [m['stage'], m['thresholdMinutes']])).toEqual([
      ['seedling', 10_000],
      ['growing_tree', 50_000],
      ['bloom', 100_000],
      ['final_form', 500_000],
    ]);

    expect(await get(ana, '/me/season')).toMatchObject({
      hemisphere: 'north',
      theme: { id: 'autumn-2026-north', environmentId: 'autumn' },
      rewards: [{ requiredActiveDays: 10, activeDays: 0, owned: false }],
    });
    expect(await get(ben, '/me/season')).toMatchObject({
      hemisphere: 'south',
      theme: { id: 'spring-2026-south', environmentId: 'sakura' },
    });

    // Ten days of normal focus in the season earn its badge, owned forever.
    await t.focus(
      ana,
      dateRange('2026-10-10', 10).map((date) => [date, 25]),
    );
    expect(await get(ana, '/me/season')).toMatchObject({
      rewards: [{ activeDays: 10, owned: true, item: { id: 'season:autumn-2026-north' } }],
    });
  });
});
