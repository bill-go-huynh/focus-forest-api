import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.8 Leaderboards (spec §16, docs/02 Leaderboards, docs/06 Leaderboard, docs/12 Phase 16): fair
 * scores that never rank raw hours alone, opt-in visibility, friends by default, weekly and
 * monthly periods. Event boards and teams were removed with events (owner, 2026-10-22).
 */

const t = new ConsistencyHarness('2026-10-18T12:00:00.000Z');
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;
interface Row {
  rank: number;
  person: { id: string; username: string | null; displayName: string | null };
  score: number;
  you: boolean;
}
interface Board {
  scope: string;
  period: { kind: string; startDate: string; endDate: string };
  optedIn: boolean;
  rows: Row[];
  you: Row | null;
}

/** A user who has opted in, with a 30-minute daily goal since September. */
async function person(name: string, over: { optIn?: boolean } = {}): Promise<User> {
  const user = await t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
  await t.prisma.user.update({
    where: { id: user.userId },
    data: { displayName: name[0]!.toUpperCase() + name.slice(1), username: name },
  });
  await t.prisma.dailyGoalSetting.create({
    data: { userId: user.userId, effectiveFrom: new Date('2026-09-01'), minutes: 30 },
  });
  if (over.optIn !== false) {
    await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
  }
  return user;
}
async function friends(a: User, b: User) {
  const createdAt = new Date('2026-10-01T00:00:00Z');
  await t.prisma.follow.createMany({
    data: [
      { followerId: a.userId, followeeId: b.userId, createdAt },
      { followerId: b.userId, followeeId: a.userId, createdAt },
    ],
  });
}
const board = async (user: User, query = '') =>
  (await t.http().get(`/leaderboards${query}`).set(user.auth).expect(200)).body as Board;
const names = (b: Board) => b.rows.map((row) => [row.rank, row.person.username, row.score]);

/** This week (12–18 October): five days of 30 minutes, each meeting the goal. */
const steadyWeek = (user: User) =>
  t.focus(user, [
    ['2026-10-12', 30],
    ['2026-10-13', 30],
    ['2026-10-14', 30],
    ['2026-10-15', 30],
    ['2026-10-16', 30],
  ]);

describe('Leaderboards (A5.8, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-18T12:00:00.000Z');
    await t.activateConfig();
  });

  describe('opt-in', () => {
    it('is off by default, and someone who has not opted in never appears', async () => {
      const ada = await person('ada', { optIn: false });
      const bob = await person('bob');
      await friends(ada, bob);
      await steadyWeek(ada);
      await steadyWeek(bob);
      const privacy = (await t.http().get('/me/privacy').set(ada.auth).expect(200)).body as Body;
      expect(privacy['leaderboards']).toBe(false);
      // Other privacy choices never opt in.
      await t.http().patch('/me/privacy').set(ada.auth).send({ profile: 'public' }).expect(200);

      // Ada can read the boards without being on them.
      const seen = await board(ada);
      expect(seen).toMatchObject({ scope: 'friends', optedIn: false, you: null });
      expect(names(seen)).toEqual([[1, 'bob', 607]]);
      expect(names(await board(bob, '?scope=global'))).toEqual([[1, 'bob', 607]]);

      await t.http().patch('/me/privacy').set(ada.auth).send({ leaderboards: true }).expect(200);
      const after = await board(ada);
      expect(after.optedIn).toBe(true);
      expect(names(after)).toEqual([
        [1, 'ada', 607],
        [1, 'bob', 607],
      ]);
      expect(after.you).toMatchObject({ rank: 1, you: true, person: { username: 'ada' } });
    });
  });

  describe('fair scores', () => {
    it('never rank raw hours alone: steady days beat one long day', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      // One ten-hour day (a discarded session adds nothing).
      await t.focus(ada, [
        ['2026-10-14', 600],
        ['2026-10-15', 600, 'discarded'],
      ]);
      // Two short days, each below the 30-minute goal.
      const eve = await person('eve');
      await t.focus(eve, [
        ['2026-10-12', 15],
        ['2026-10-13', 15],
      ]);
      await steadyWeek(bob);
      // Three days of focus and two planned rest days: rest is never a penalty.
      await t.focus(cyd, [
        ['2026-10-12', 30],
        ['2026-10-14', 30],
        ['2026-10-16', 30],
      ]);
      await t.prisma.restDay.createMany({
        data: [
          { userId: cyd.userId, date: new Date('2026-10-13') },
          { userId: cyd.userId, date: new Date('2026-10-15') },
        ],
      });
      // A missed day repaired by a streak recovery is kept too.
      const dan = await person('dan');
      await t.focus(dan, [['2026-10-13', 30]]);
      await t.prisma.streakRecovery.create({
        data: {
          userId: dan.userId,
          missedDate: new Date('2026-10-12'),
          returnDate: new Date('2026-10-13'),
          mechanic: 'next_day_session',
        },
      });
      // Weights 30/30/20/20, a 120-minute daily cap, 7 days:
      // ada 143 (1 day kept, met, active; 120 capped minutes), bob 607, cyd 450, dan 164,
      // eve 150 (2 days kept and active, no goal met, 30 minutes).
      expect(names(await board(ada, '?scope=global'))).toEqual([
        [1, 'bob', 607],
        [2, 'cyd', 450],
        [3, 'dan', 164],
        [4, 'eve', 150],
        [5, 'ada', 143],
      ]);
    });

    it('follow the configured weights and daily cap', async () => {
      const ada = await person('ada');
      await t.focus(ada, [['2026-10-14', 600]]);
      await t.activateConfig({
        'leaderboard.scoreWeights': { consistency: 0, goals: 0, activeDays: 50, focusTime: 50 },
        'leaderboard.dailyFocusCapMinutes': 600,
      });
      // 1000 × (50 × 1/7 + 50 × 600/4200) ÷ 100 = 143.
      expect(names(await board(ada, '?scope=global'))).toEqual([[1, 'ada', 143]]);
    });

    it('share ranks on ties, listed by display name', async () => {
      const cyd = await person('cyd');
      const ada = await person('ada');
      const bob = await person('bob');
      for (const user of [cyd, ada, bob]) await steadyWeek(user);
      await t.focus(bob, [['2026-10-17', 30]]);
      expect(names(await board(ada, '?scope=global'))).toEqual([
        [1, 'bob', 729],
        [2, 'ada', 607],
        [2, 'cyd', 607],
      ]);
    });
  });

  describe('scopes', () => {
    it('default to friends: mutual follows only, never a one-way follow', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(ada, bob);
      await t.prisma.follow.create({
        data: { followerId: ada.userId, followeeId: cyd.userId, createdAt: new Date() },
      });
      for (const user of [ada, bob, cyd]) await steadyWeek(user);
      expect(names(await board(ada)).map((row) => row[1])).toEqual(['ada', 'bob']);
      expect(names(await board(ada, '?scope=global')).map((row) => row[1])).toEqual([
        'ada',
        'bob',
        'cyd',
      ]);
    });

    it('never show blocked, suspended, or banned people, or an empty period', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const dan = await person('dan');
      const eve = await person('eve');
      await person('fay');
      for (const user of [ada, bob, cyd, dan, eve]) await steadyWeek(user);
      await t.prisma.block.create({
        data: { blockerId: bob.userId, blockedId: ada.userId, createdAt: new Date() },
      });
      await t.prisma.user.update({ where: { id: cyd.userId }, data: { status: 'suspended' } });
      await t.prisma.user.update({ where: { id: dan.userId }, data: { status: 'banned' } });
      expect(names(await board(ada, '?scope=global')).map((row) => row[1])).toEqual(['ada', 'eve']);
      expect(names(await board(bob, '?scope=global')).map((row) => row[1])).toEqual(['bob', 'eve']);
    });

    it('list at most 50 people, and always answer your own row', async () => {
      const ada = await person('ada');
      await t.focus(ada, [['2026-10-12', 30]]);
      const createdAt = new Date('2026-09-01T00:00:00Z');
      const others = Array.from({ length: 50 }, (_, i) => ({
        id: randomUUID(),
        email: `p${i}@example.com`,
        passwordHash: 'x',
        displayName: `P${String(i).padStart(2, '0')}`,
        timezone: 'UTC',
        createdAt,
      }));
      await t.prisma.user.createMany({ data: others });
      await t.prisma.privacySettings.createMany({
        data: others.map((o) => ({
          userId: o.id,
          profile: 'friends',
          forest: 'friends',
          statistics: 'private',
          badges: 'friends',
          currentTree: 'friends',
          leaderboards: true,
        })),
      });
      for (const other of others) {
        const topic = await t.prisma.topic.create({
          data: {
            id: randomUUID(),
            userId: other.id,
            name: 'Work',
            icon: 'book',
            color: 'topic.1',
            createFingerprint: 'test',
          },
        });
        await t.focus({ userId: other.id, topicId: topic.id }, [
          ['2026-10-12', 30],
          ['2026-10-13', 30],
        ]);
      }
      const seen = await board(ada, '?scope=global');
      expect(seen.rows).toHaveLength(50);
      expect(seen.rows.some((row) => row.you)).toBe(false);
      expect(seen.you).toMatchObject({ rank: 51, you: true, person: { username: 'ada' } });
    });
  });

  describe('periods', () => {
    it("reset weekly from Monday and monthly from the first, in the viewer's days", async () => {
      const ada = await person('ada');
      await t.focus(ada, [
        ['2026-09-30', 30],
        ['2026-10-05', 30],
        ['2026-10-12', 30],
      ]);
      const weekly = await board(ada, '?scope=global&period=weekly');
      expect(weekly.period).toEqual({
        kind: 'weekly',
        startDate: '2026-10-12',
        endDate: '2026-10-18',
      });
      // 1000 × (30 + 30 + 20 + 20 × 30/120) ÷ 100 ÷ 7 = 121.
      expect(names(weekly)).toEqual([[1, 'ada', 121]]);
      const monthly = await board(ada, '?scope=global&period=monthly');
      expect(monthly.period).toEqual({
        kind: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
      });
      // Two days of 31: 1000 × 2 × 0.85 ÷ 31 = 55.
      expect(names(monthly)).toEqual([[1, 'ada', 55]]);
      // A fresh week: nothing yet is not a last place.
      await t.setNow('2026-10-19T12:00:00.000Z');
      expect((await board(ada, '?scope=global')).rows).toEqual([]);
    });

    it('refuses an unknown scope or period', async () => {
      const ada = await person('ada');
      await t.http().get('/leaderboards?scope=world').set(ada.auth).expect(400);
      await t.http().get('/leaderboards?period=daily').set(ada.auth).expect(400);
      await t.http().get('/leaderboards?scope=event').set(ada.auth).expect(400);
      await t
        .http()
        .get('/leaderboards?scope=global&eventId=team-sprint')
        .set(ada.auth)
        .expect(400);
      expect(Object.keys(await board(ada, '?scope=global'))).not.toContain('teams');
    });
  });

  describe('configuration', () => {
    it('refuses weights that rank focus time alone', async () => {
      await expect(
        t.activateConfig({
          'leaderboard.scoreWeights': { consistency: 0, goals: 0, activeDays: 0, focusTime: 100 },
        }),
      ).rejects.toThrow();
      await expect(
        t.activateConfig({
          'leaderboard.scoreWeights': { consistency: 0, goals: 0, activeDays: 0, focusTime: 0 },
        }),
      ).rejects.toThrow();
    });
  });
});
