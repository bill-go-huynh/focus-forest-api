import { randomUUID } from 'node:crypto';

import { addDays, type LocalDate } from '../../src/common/local-date.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.2.G: accepting a streak recovery can raise the authoritative longest streak across an
 * achievement threshold. The badge is granted in the recovery's own transaction, and the
 * recovery answers it as `progression.newlyEarnedBadges`, stored with the recovery so a repeat
 * answers the same. A recovery never creates focus, an active day, or tree growth.
 */

const NOW = '2026-10-07T20:00:00.000Z';
const MISSED = '2026-10-05';
const RETURN = '2026-10-06';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

interface BadgeBody {
  id: string;
  earnedAt: string;
  [key: string]: unknown;
}

interface RecoveryBody {
  current: number;
  longest: number;
  progression: { newlyEarnedBadges: BadgeBody[] } | null;
}

const recover = (user: User, missedDate = MISSED) =>
  t.http().post('/me/streak/recoveries').set(user.auth).send({ missedDate });
const newly = (body: RecoveryBody) => body.progression?.newlyEarnedBadges.map((b) => b.id);
const ownedIds = async (userId: string) =>
  (await t.prisma.userBadge.findMany({ where: { userId }, orderBy: { badgeId: 'asc' } })).map(
    (row) => row.badgeId,
  );

/**
 * A run of `run` active days ending the day before the missed day, the missed day, and the
 * return session the day after (15 minutes a day, so no focus-hour badge is near). Earlier
 * badges are settled first, so the recovery's own result is what is measured.
 */
async function brokenRun(email: string, run: number): Promise<User> {
  const user = await t.signUp(email);
  const start: LocalDate = addDays(MISSED, -run);
  await t.focus(user, [
    ...dateRange(start, run).map((date) => [date, 15] as [string, number]),
    [RETURN, 15],
  ]);
  await t.http().get('/me/badges').set(user.auth).expect(200);
  return user;
}

async function digest(tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await t.prisma.$queryRawUnsafe<{ md5: string | null }[]>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${table}" t`,
    );
    out[table] = row?.md5 ?? 'empty';
  }
  return out;
}

describe('A4.2.G recovery achievements (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  it('grants the 30-day badge when a recovery turns a 29-day run into 30, in that action', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    expect(await ownedIds(ada.userId)).not.toContain('focus-streak:30');
    const res = await recover(ada).expect(201);
    const body = res.body as RecoveryBody;
    expect(body).toMatchObject({ current: 30, longest: 30 });
    expect(body.progression).toEqual({
      newlyEarnedBadges: [
        {
          id: 'focus-streak:30',
          name: '30-Day Streak',
          description: 'Focused 30 days in a row.',
          category: 'consistency',
          rarity: 'rare',
          artworkId: 'focus-streak-30',
          earnedAt: NOW,
        },
      ],
    });
    const row = await t.prisma.userBadge.findUniqueOrThrow({
      where: { userId_badgeId: { userId: ada.userId, badgeId: 'focus-streak:30' } },
    });
    expect(row.earnedAt).toEqual(new Date(NOW));
  });

  it('grants nothing when the recovered run crosses no threshold', async () => {
    const ada = await brokenRun('ada@example.com', 10);
    const before = await ownedIds(ada.userId);
    const res = await recover(ada).expect(201);
    expect(res.body as RecoveryBody).toMatchObject({ longest: 11 });
    expect((res.body as RecoveryBody).progression).toEqual({ newlyEarnedBadges: [] });
    expect(await ownedIds(ada.userId)).toEqual(before);
  });

  it('reports only what the recovery caused, not badges history had already reached', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.focus(ada, [
      ...dateRange(addDays(MISSED, -29), 29).map((date) => [date, 15] as [string, number]),
      [RETURN, 15],
    ]);
    // Nothing reconciled yet: First Session and the 3- and 7-day streaks are granted now too.
    const res = await recover(ada).expect(201);
    expect(newly(res.body as RecoveryBody)).toEqual(['focus-streak:30']);
    expect(await ownedIds(ada.userId)).toEqual([
      'first-session',
      'focus-streak:3',
      'focus-streak:30',
      'focus-streak:7',
    ]);
  });

  it('reads the longest streak, not the current one: an older 31-day run already earned 30', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.focus(ada, [
      ...dateRange('2026-07-01', 31).map((date) => [date, 15] as [string, number]),
      ...dateRange(addDays(MISSED, -5), 5).map((date) => [date, 15] as [string, number]),
      [RETURN, 15],
    ]);
    // The recovery makes the current run 6: it crosses nothing itself, but the evaluation in
    // its transaction grants what the longest streak (31) had already reached.
    const res = await recover(ada).expect(201);
    expect(res.body as RecoveryBody).toMatchObject({ current: 6, longest: 31 });
    expect(newly(res.body as RecoveryBody)).toEqual([]);
    expect(await ownedIds(ada.userId)).toContain('focus-streak:30');
  });

  it('answers a repeated acceptance with the same stored result, never a second grant', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    const first = (await recover(ada).expect(201)).body as RecoveryBody;
    await t.setNow('2026-10-07T21:00:00.000Z');
    const repeat = (await recover(ada).expect(200)).body as RecoveryBody;
    expect(repeat.progression).toEqual(first.progression);
    expect(
      await t.prisma.userBadge.count({ where: { userId: ada.userId, badgeId: 'focus-streak:30' } }),
    ).toBe(1);
  });

  it('grants once under concurrent acceptances, each answering the same result', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    const responses = await Promise.all([recover(ada), recover(ada), recover(ada)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 201]);
    const results = responses.map((res) => (res.body as RecoveryBody).progression);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]?.newlyEarnedBadges.map((b) => b.id)).toEqual(['focus-streak:30']);
    expect(
      await t.prisma.userBadge.count({ where: { userId: ada.userId, badgeId: 'focus-streak:30' } }),
    ).toBe(1);
    expect(await t.prisma.streakRecovery.count({ where: { userId: ada.userId } })).toBe(1);
  });

  it('keeps recovery semantics: no session, no active day, no tree or vitality change', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    const treeBefore = (await t.http().get('/me/trees/current').set(ada.auth).expect(200)).body as {
      tree: { progress: unknown };
    };
    const tables = ['focus_sessions', 'monthly_trees', 'monthly_tree_traits', 'rest_days'];
    const before = await digest(tables);
    const body = (await recover(ada).expect(201)).body as RecoveryBody;
    // The recovered day bridges the run without counting: 29 + 1 active days.
    expect(body).toMatchObject({ current: 30, longest: 30 });
    expect(await digest(tables)).toEqual(before);
    expect(await t.prisma.focusSession.count({ where: { userId: ada.userId } })).toBe(30);
    // The tree reads the recovery as Phase 3 does; the badge adds nothing to it.
    const treeAfter = (await t.http().get('/me/trees/current').set(ada.auth).expect(200)).body as {
      tree: { progress: unknown; vitality: unknown };
    };
    expect(treeAfter.tree.progress).toEqual(treeBefore.tree.progress);
  });

  it('keeps users apart', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    const bob = await brokenRun('bob@example.com', 29);
    await recover(ada).expect(201);
    expect(await ownedIds(bob.userId)).not.toContain('focus-streak:30');
    const res = await recover(bob).expect(201);
    expect(newly(res.body as RecoveryBody)).toEqual(['focus-streak:30']);
  });

  it('never grants planned, Social, or Event badges', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    for (const [id, category, source, status] of [
      ['streak-together', 'social', 'achievement', 'active'],
      ['event-streak', 'event', 'event', 'active'],
      ['planned-streak', 'consistency', 'achievement', 'planned'],
    ] as const) {
      await t.prisma.badgeDefinition.create({
        data: {
          id,
          category,
          rarity: 'common',
          source,
          availability: 'permanent',
          status,
          name: id,
          description: 'For tests.',
          artworkId: id,
        },
      });
      await t.prisma.achievementDefinition.create({
        data: { id, badgeId: id, criterion: 'longest_streak_days', target: 30 },
      });
    }
    const res = await recover(ada).expect(201);
    expect(newly(res.body as RecoveryBody)).toEqual(['focus-streak:30']);
    expect(await ownedIds(ada.userId)).not.toEqual(
      expect.arrayContaining(['streak-together', 'event-streak', 'planned-streak']),
    );
  });

  it('shows the badge as earned afterwards, never as new again', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    await recover(ada).expect(201);
    const list = (await t.http().get('/me/achievements').set(ada.auth).expect(200)).body as {
      items: { id: string; completed: boolean; earnedAt: string | null }[];
    };
    expect(list.items.find((a) => a.id === 'focus-streak:30')).toMatchObject({
      completed: true,
      earnedAt: NOW,
    });
    // A later session never reports it.
    await t.setNow('2026-10-07T22:00:00.000Z');
    const session = await t.submit(ada, '2026-10-07T21:00:00.000Z', 20, randomUUID());
    expect(session.status).toBe(201);
    expect(
      (session.body as { progression: { newlyEarnedBadges: BadgeBody[] } }).progression,
    ).toEqual({ newlyEarnedBadges: [] });
  });

  it('answers null for a recovery stored before A4.2.G: nothing is fabricated', async () => {
    const ada = await brokenRun('ada@example.com', 29);
    await recover(ada).expect(201);
    await t.prisma.streakRecovery.updateMany({
      where: { userId: ada.userId },
      data: { progressionResult: Prisma.DbNull },
    });
    const repeat = (await recover(ada).expect(200)).body as RecoveryBody;
    expect(repeat.progression).toBeNull();
  });
});
