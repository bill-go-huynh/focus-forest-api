import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * Final review FR.3: the core invariants under seeded random months (HTTP + PostgreSQL).
 *
 * Each seed lives September and October 2026 at random: sessions of random length (some too short
 * to count), rest days, daily goal changes, and late sessions after September closes. After every
 * step it checks what must always hold, whatever the person does (docs/06, docs/03):
 * - earned tree dimensions (stage, fullness, blossoms, richness, traits) never go down;
 * - an archived tree and its recap never change;
 * - every number agrees with History (counted sessions only);
 * - the forest has every month, in order, with no gap.
 * The generator is a fixed-seed PRNG (no dependency), so a failure replays exactly.
 */

const MIN = 60_000;
const t = new ConsistencyHarness('2026-09-01T00:30:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LENGTHS = [2, 4, 5, 15, 25, 45, 60, 90, 150, 200];
const day = (month: number, date: number) =>
  `2026-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

type Progress = TreeStateDto['progress'];
function expectNoLoss(before: TreeStateDto, after: TreeStateDto, where: string): void {
  const p = (x: Progress) => [
    x.stageNumber,
    x.fullness.level,
    x.blossoms.level,
    x.richness.tier,
    x.growthMinutes,
  ];
  p(after.progress).forEach((value, i) =>
    expect(value, `${where}: dimension ${i}`).toBeGreaterThanOrEqual(p(before.progress)[i]!),
  );
  const ids = (tree: TreeStateDto) => tree.traits.map((trait) => trait.id);
  expect(ids(after), where).toEqual(expect.arrayContaining(ids(before)));
}

describe('final review FR.3: core invariants under random months (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-01T00:30:00.000Z');
    await t.activateConfig();
  });

  const get = async <T>(user: User, path: string) =>
    (await t.http().get(path).set(user.auth).expect(200)).body as T;
  const tree = async (user: User, month: number) =>
    (await get<{ tree: TreeStateDto }>(user, `/me/trees/2026/${month}`)).tree;

  async function agreesWithHistory(user: User, month: number): Promise<void> {
    const history = await get<{ items: { counted: boolean; focusedMilliseconds: number }[] }>(
      user,
      `/me/sessions?month=2026-${String(month).padStart(2, '0')}&limit=100`,
    );
    const counted = history.items.filter((s) => s.counted);
    const insights = await get<{ summary: { focusedMilliseconds: number; sessionCount: number } }>(
      user,
      `/me/insights/month?year=2026&month=${month}`,
    );
    expect(insights.summary).toMatchObject({
      focusedMilliseconds: counted.reduce((sum, s) => sum + s.focusedMilliseconds, 0),
      sessionCount: counted.length,
    });
  }

  it.each([11, 2026, 90210])(
    'seed %i',
    async (seed) => {
      const random = prng(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
      const ada = await t.signUp(`seed${seed}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 45 }).expect(200);

      let september: { tree: TreeStateDto; recap: unknown } | null = null;
      const latest: Record<number, TreeStateDto> = {};

      for (const [month, days] of [
        [9, 30],
        [10, 31],
      ] as const) {
        for (let date = 1; date <= days; date += 1) {
          const today = day(month, date);
          await t.setNow(`${today}T05:00:00.000Z`);
          // Now and then: plan tomorrow as rest (the weekly allowance may refuse), change the goal.
          if (random() < 0.15) {
            const next = new Date(Date.parse(`${today}T00:00:00.000Z`) + 24 * 60 * MIN);
            const res = await t
              .http()
              .put(`/me/rest-days/${next.toISOString().slice(0, 10)}`)
              .set(ada.auth);
            expect([200, 201, 409]).toContain(res.status);
          }
          if (random() < 0.1) {
            await t
              .http()
              .put('/me/goals/daily')
              .set(ada.auth)
              .send({ minutes: pick([15, 30, 60, 90]) })
              .expect(200);
          }
          // Zero to three sessions, one after another from 06:00.
          let start = Date.parse(`${today}T06:00:00.000Z`);
          const count = pick([0, 0, 1, 1, 2, 3]);
          for (let i = 0; i < count; i += 1) {
            const minutes = pick(LENGTHS);
            await t.setNow(new Date(start + (minutes + 1) * MIN).toISOString());
            await t.submit(ada, new Date(start).toISOString(), minutes).expect(201);
            start += (minutes + 10) * MIN;
            const now = await tree(ada, month);
            if (latest[month]) expectNoLoss(latest[month], now, `seed ${seed}, ${today}`);
            latest[month] = now;
          }

          // In October, a late session for September may arrive, which never changes its archive.
          if (month === 10 && september && random() < 0.2) {
            const lateDay = day(9, 1 + Math.floor(random() * 30));
            const res = await t.submit(ada, `${lateDay}T20:00:00.000Z`, pick(LENGTHS));
            // A late session may overlap one already stored there, and is then refused.
            expect([201, 409, 422]).toContain(res.status);
            expect(await tree(ada, 9)).toEqual(september.tree);
            expect(await get(ada, '/me/trees/2026/9/recap')).toEqual(september.recap);
          }

          // Once September has closed (3 hours into 1 October), keep its archive to compare.
          if (month === 10 && !september) {
            await t.setNow('2026-10-01T03:01:00.000Z');
            await get(ada, '/me/home');
            september = {
              tree: await tree(ada, 9),
              recap: await get(ada, '/me/trees/2026/9/recap'),
            };
            expect(september.tree.status).toBe('archived');
            if (latest[9]) expectNoLoss(latest[9], september.tree, `seed ${seed}, archive`);
          }
        }
      }

      // Close October, then check every surface once more.
      await t.setNow('2026-11-01T03:01:00.000Z');
      await get(ada, '/me/home');
      const october = await tree(ada, 10);
      expect(october.status).toBe('archived');
      if (latest[10]) expectNoLoss(latest[10], october, `seed ${seed}, October archive`);
      expect(await tree(ada, 9)).toEqual(september!.tree);
      await agreesWithHistory(ada, 9);
      await agreesWithHistory(ada, 10);

      // The forest: November (growing edge), October, September; nothing missing.
      const forest = await get<{ items: { year: number; month: number }[] }>(ada, '/me/forest');
      expect(forest.items.map((item) => `${item.year}-${item.month}`)).toEqual([
        '2026-11',
        '2026-10',
        '2026-9',
      ]);
    },
    600_000,
  );
});
