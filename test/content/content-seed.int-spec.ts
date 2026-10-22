import { applyContentPack } from '../../src/content/apply-content-pack.js';
import type { ContentPack } from '../../src/content/content-pack.js';
import { LAUNCH_CONTENT } from '../../src/content/launch-content.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * Content packs (`npm run content:seed`): the Phase 5 launch content (seasonal themes and their
 * badges; events were removed, owner 2026-10-22) applied to a database outside the migrations, so dated
 * content never reaches a test database unasked. A pack only adds what is missing: rerunning it
 * changes nothing, and content the owner has since edited stays as edited.
 */

const t = new ConsistencyHarness('2026-10-25T10:00:00.000Z');
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

const counts = async () => ({
  badges: await t.prisma.badgeDefinition.count({ where: { source: 'season' } }),
  themes: await t.prisma.seasonalTheme.count(),
  seasonalRewards: await t.prisma.seasonalReward.count(),
});

const expected = {
  badges: LAUNCH_CONTENT.badges.length,
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
        themes: LAUNCH_CONTENT.themes.map((theme) => theme.id),
      },
      kept: { badges: 0, themes: [] },
    });
    expect(await counts()).toEqual(expected);

    const badge = await t.prisma.badgeDefinition.findUniqueOrThrow({
      where: { id: 'season:spring-2026-south' },
    });
    expect(badge).toMatchObject({
      category: 'event',
      source: 'season',
      availability: 'limited',
      status: 'active',
      artworkId: 'season-spring-2026-south',
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
      added: { badges: 0, themes: [] },
      kept: {
        badges: expected.badges,
        themes: LAUNCH_CONTENT.themes.map((theme) => theme.id),
      },
    });
    expect(await counts()).toEqual(expected);
  });

  it('keeps content the owner has edited since', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    await t.prisma.badgeDefinition.update({
      where: { id: 'season:autumn-2026-north' },
      data: { name: 'Autumn Leaves 2026' },
    });
    await t.prisma.seasonalTheme.update({
      where: { id: 'autumn-2026-north' },
      data: { status: 'retired' },
    });

    await applyContentPack(t.prisma, LAUNCH_CONTENT);

    expect(
      (
        await t.prisma.badgeDefinition.findUniqueOrThrow({
          where: { id: 'season:autumn-2026-north' },
        })
      ).name,
    ).toBe('Autumn Leaves 2026');
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
          id: 'season:rain-2028-north',
          name: 'Rain 2028',
          description: 'Focused on ten rainy days.',
          rarity: 'common',
          source: 'season',
          availableFrom: '2028-01-01T00:00:00.000Z',
          availableUntil: '2028-04-15T00:00:00.000Z',
        },
      ],
      themes: [
        {
          id: 'rain-2028-north',
          name: 'Rain',
          description: 'Soft rain over the forest.',
          environmentId: 'rain',
          hemisphere: 'north',
          startsAt: '2028-01-01T00:00:00.000Z',
          endsAt: '2028-04-01T00:00:00.000Z',
          rewards: [{ id: 'ten-days', badgeId: 'season:rain-2028-north', requiredActiveDays: 10 }],
        },
      ],
    };

    const result = await applyContentPack(t.prisma, later);

    expect(result.added).toEqual({ badges: 1, themes: ['rain-2028-north'] });
    expect(await t.prisma.seasonalTheme.count()).toBe(expected.themes + 1);
  });

  it('refuses a pack with problems, and writes nothing', async () => {
    const broken: ContentPack = {
      ...LAUNCH_CONTENT,
      themes: LAUNCH_CONTENT.themes.map((theme, i) =>
        i === 0 ? { ...theme, environmentId: 'fireworks' } : theme,
      ),
    };

    await expect(applyContentPack(t.prisma, broken)).rejects.toThrow(/fireworks/);
    expect(await t.prisma.seasonalTheme.count()).toBe(0);
    expect(await t.prisma.badgeDefinition.count({ where: { source: 'season' } })).toBe(0);
  });

  it('is served by the API: each hemisphere’s season', async () => {
    await applyContentPack(t.prisma, LAUNCH_CONTENT);
    const ana = await t.signUp('ana@example.com', 'Europe/Berlin');
    const ben = await t.signUp('ben@example.com', 'Australia/Sydney');

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
