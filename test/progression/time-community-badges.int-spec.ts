import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * Time-based badges and Community Contributor (owner decision 2026-10-15; docs/06 Badge; spec
 * §9.1), over HTTP and PostgreSQL:
 * - Early Bird: 10 counted sessions started before 07:00;
 * - Night Owl: 10 counted sessions started at or after 22:00;
 * - Weekend Warrior: counted focus on both days of 4 weekends;
 * - Community Contributor: an event participant's first counted session that adds minutes to a
 *   Community Tree.
 * Times are local to the session's month (Mai is in Ho Chi Minh City, UTC+7, so 06:30 there is
 * 23:30 UTC the day before). Each badge is reported by the session that earned it.
 */

const MIN = 60_000;
const t = new ConsistencyHarness('2026-10-01T00:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
type Body = { progression: { newlyEarnedBadges: { id: string }[] } };

/** "2026-10-05T06:30" in Ho Chi Minh City → the ISO instant. */
const hcm = (local: string) =>
  new Date(Date.parse(`${local}:00.000Z`) - 7 * 60 * MIN).toISOString();
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

describe('time-based badges and Community Contributor (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-01T00:00:00.000Z');
    await t.activateConfig();
  });

  const mai = () => t.signUp('mai@example.com', 'Asia/Ho_Chi_Minh', '2026-09-01T00:00:00.000Z');
  async function focus(user: User, startedAt: string, minutes = 25): Promise<string[]> {
    await t.setNow(new Date(Date.parse(startedAt) + (minutes + 1) * MIN).toISOString());
    const res = await t.submit(user, startedAt, minutes).expect(201);
    return (res.body as Body).progression.newlyEarnedBadges.map((badge) => badge.id);
  }
  const progress = async (user: User, id: string) => {
    const body = (await t.http().get('/me/achievements').set(user.auth).expect(200)).body as {
      items: { id: string; unit: string; current: number; target: number; completed: boolean }[];
    };
    return body.items.find((item) => item.id === id);
  };

  it('Early Bird: ten sessions started before 07:00 local time; 07:00 and short ones do not count', async () => {
    const user = await mai();
    // 07:00 exactly is not "before 7"; a 3-minute session never counts.
    expect(await focus(user, hcm(`${day(2)}T07:00`))).not.toContain('early-bird');
    expect(await focus(user, hcm(`${day(3)}T06:00`), 3)).not.toContain('early-bird');
    for (let n = 4; n <= 12; n += 1) {
      expect(await focus(user, hcm(`${day(n)}T06:30`))).not.toContain('early-bird');
    }
    expect(await progress(user, 'early-bird')).toMatchObject({
      unit: 'sessions',
      current: 9,
      target: 10,
      completed: false,
    });
    expect(await focus(user, hcm(`${day(13)}T06:59`))).toContain('early-bird');
    expect(await progress(user, 'early-bird')).toMatchObject({ current: 10, completed: true });
  });

  it('Night Owl: ten sessions started at or after 22:00 local time; 21:59 does not count', async () => {
    const user = await mai();
    expect(await focus(user, hcm(`${day(2)}T21:59`))).not.toContain('night-owl');
    for (let n = 3; n <= 11; n += 1) {
      expect(await focus(user, hcm(`${day(n)}T22:00`))).not.toContain('night-owl');
    }
    expect(await focus(user, hcm(`${day(12)}T23:10`))).toContain('night-owl');
  });

  it('Weekend Warrior: both days of four weekends, not in a row, counted in weekends', async () => {
    const user = await mai();
    // October 2026: Saturdays 3, 10, 17, 24, 31. The weekend of the 10th has Saturday only.
    for (const n of [3, 4, 10, 17, 18, 24]) {
      expect(await focus(user, hcm(`${day(n)}T10:00`))).not.toContain('weekend-warrior');
    }
    expect(await progress(user, 'weekend-warrior')).toMatchObject({
      unit: 'weekends',
      current: 2,
      target: 4,
    });
    expect(await focus(user, hcm(`${day(25)}T10:00`))).not.toContain('weekend-warrior');
    expect(await focus(user, hcm(`${day(31)}T10:00`))).not.toContain('weekend-warrior');
    expect(await focus(user, hcm('2026-11-01T10:00'))).toContain('weekend-warrior');
  });

  it('Community Contributor: the first session that grows a Community Tree, only as a participant', async () => {
    await t.prisma.event.create({
      data: {
        id: 'shared-garden',
        name: 'Shared Garden',
        description: 'A week of growing one tree together.',
        artworkId: 'shared-garden',
        status: 'active',
        startsAt: new Date('2026-10-15T00:00:00Z'),
        endsAt: new Date('2026-10-22T00:00:00Z'),
        communityTree: { create: { name: 'The Garden Oak', artworkId: 'garden-oak' } },
      },
    });
    const user = await mai();
    const bystander = await t.signUp('kai@example.com', 'UTC', '2026-09-01T00:00:00.000Z');

    // Before the event, and without joining it, focus grows no shared tree.
    expect(await focus(user, '2026-10-14T03:00:00.000Z')).not.toContain('community-contributor');
    await t.setNow('2026-10-15T01:00:00.000Z');
    await t.http().post('/events/shared-garden/join').set(user.auth).expect(200);
    expect(await focus(bystander, '2026-10-15T02:00:00.000Z')).not.toContain(
      'community-contributor',
    );
    // A discarded session adds nothing.
    expect(await focus(user, '2026-10-15T04:00:00.000Z', 3)).not.toContain('community-contributor');
    // The participant's first counted session in the window grows the tree: earned, reported.
    expect(await focus(user, '2026-10-15T05:00:00.000Z')).toContain('community-contributor');
    expect(await focus(user, '2026-10-16T05:00:00.000Z')).not.toContain('community-contributor');
    const owned = await t.prisma.userBadge.findMany({
      where: { badgeId: 'community-contributor' },
    });
    expect(owned.map((row) => row.userId)).toEqual([user.userId]);
  });

  it('are listed in their categories with every other earnable badge', async () => {
    const user = await mai();
    const body = (await t.http().get('/me/achievements').set(user.auth).expect(200)).body as {
      items: { id: string; badge: { category: string } }[];
    };
    const categories = Object.fromEntries(body.items.map((item) => [item.id, item.badge.category]));
    expect(categories).toMatchObject({
      'early-bird': 'time_based',
      'night-owl': 'time_based',
      'weekend-warrior': 'time_based',
      'community-contributor': 'social',
    });
  });
});
