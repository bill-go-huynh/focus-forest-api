import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

// Wednesday 7 October 2026, 20:00 UTC.
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW, { countQueries: true });

type User = Awaited<ReturnType<typeof t.signUp>>;

type ForestItem =
  | {
      kind: 'archived' | 'growing';
      year: number;
      month: number;
      tree: TreeStateDto;
      focusedMilliseconds: number;
    }
  | { kind: 'resting'; year: number; month: number; focusedMilliseconds: number };

interface ForestPage {
  items: ForestItem[];
  nextCursor: string | null;
  progression: {
    level: number;
    maxLevel: number;
    treeCount: number;
    nextLevelAt: number | null;
    unlockedAreas: string[];
  };
  summary: { treeCount: number; lifetimeFocusedMinutes: number };
}

interface Recap {
  year: number;
  month: number;
  generatedAt: string;
  tree: TreeStateDto;
  stats: Record<string, unknown>;
  mostProductiveDay: { date: string; focusedMinutes: number } | null;
  mostProductiveWeek: { weekStart: string; focusedMinutes: number } | null;
  newRecords: { kind: string; value: number; unit: string; achievedOn: string }[];
  highlightedNotes: { sessionId: string; localDate: string; topicId: string; note: string }[];
  badges: unknown[];
  events: unknown[];
  ceremonySeenAt: string | null;
  recapSeenAt: string | null;
}

const label = (item: { year: number; month: number }) =>
  `${item.year}-${String(item.month).padStart(2, '0')}`;

describe('personal forest, tree details, and recap (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const get = async <T = Record<string, unknown>>(user: User, path: string, status = 200) =>
    (await t.http().get(path).set(user.auth).expect(status)).body as T;
  const forest = (user: User, query = '') => get<ForestPage>(user, `/me/forest${query}`);
  const submitted = async (user: User, startedAt: string, minutes: number, id?: string) =>
    (await t.submit(user, startedAt, minutes, id).expect(201)).body as { id: string };
  const note = (user: User, id: string, text: string | null) =>
    t.http().patch(`/me/sessions/${id}/note`).set(user.auth).send({ note: text }).expect(200);
  const highlight = (user: User, id: string) =>
    t.http().put(`/me/sessions/${id}/note/highlight`).set(user.auth).expect(200);
  const unhighlight = (user: User, id: string) =>
    t.http().delete(`/me/sessions/${id}/note/highlight`).set(user.auth).expect(200);

  /** Every page, following nextCursor. */
  async function allPages(user: User, limit: number): Promise<ForestPage[]> {
    const pages: ForestPage[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await forest(user, query);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  }

  describe('forest', () => {
    it('shows every month from the join month, newest first, with the growing edge first', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-06-15T09:00:00.000Z');
      await t.focus(ada, [
        ['2026-07-03', 60],
        ['2026-09-10', 30],
      ]);
      const page = await forest(ada);
      expect(page.items.map((item) => [label(item), item.kind])).toEqual([
        ['2026-10', 'growing'],
        ['2026-09', 'archived'],
        ['2026-08', 'resting'],
        ['2026-07', 'archived'],
        ['2026-06', 'resting'],
      ]);
      expect(page.nextCursor).toBeNull();
      const [current, september, august] = page.items;
      expect(current).toMatchObject({ tree: { status: 'growing', progress: { stage: 'seed' } } });
      expect(september).toMatchObject({
        tree: { status: 'archived', vitality: null, progress: { stage: 'sprout' } },
      });
      expect(august).toEqual({ kind: 'resting', year: 2026, month: 8, focusedMilliseconds: 0 });
      expect(page.summary).toEqual({ treeCount: 2, lifetimeFocusedMinutes: 90 });
    });

    it('pages through 37 months without a gap or a repeat, in bounded queries', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2023-10-01T00:00:00.000Z');
      // Focus in two months of every three, from October 2023 to September 2026.
      const months = Array.from({ length: 36 }, (_, index) => {
        const month = ((9 + index) % 12) + 1;
        const year = 2023 + Math.floor((9 + index) / 12);
        return { year, month, index };
      });
      await t.focus(
        ada,
        months
          .filter((entry) => entry.index % 3 !== 2)
          .map(
            ({ year, month }) =>
              [`${year}-${String(month).padStart(2, '0')}-10`, 60] as [string, number],
          ),
      );
      await forest(ada); // closes the 36 past months

      const pages = await allPages(ada, 10);
      expect(pages.map((page) => page.items.length)).toEqual([10, 10, 10, 7]);
      const labels = pages.flatMap((page) => page.items.map(label));
      expect(labels).toHaveLength(37);
      expect(new Set(labels).size).toBe(37);
      expect(labels[0]).toBe('2026-10');
      expect(labels.at(-1)).toBe('2023-10');
      expect([...labels].sort().reverse()).toEqual(labels);
      const kinds = pages.flatMap((page) => page.items.map((item) => item.kind));
      expect(kinds.filter((kind) => kind === 'archived')).toHaveLength(24);
      expect(kinds.filter((kind) => kind === 'resting')).toHaveLength(12);

      // The number of queries does not grow with the number of months on a page.
      const small = await t.queries.during(() => forest(ada, '?limit=3'));
      const large = await t.queries.during(() => forest(ada, '?limit=37'));
      expect(large).toBe(small);
      const older = await t.queries.during(() =>
        forest(ada, `?limit=30&cursor=${pages[0]?.nextCursor ?? ''}`),
      );
      expect(older).toBeLessThanOrEqual(small);
    }, 120_000);

    it('validates the page parameters', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.http().get('/me/forest?limit=0').set(ada.auth).expect(400);
      await t.http().get('/me/forest?limit=61').set(ada.auth).expect(400);
      await t.http().get('/me/forest?cursor=nope').set(ada.auth).expect(400);
    });

    it('levels up with planted trees, cosmetically only', async () => {
      const ada = await t.signUp('ada@example.com');
      expect((await forest(ada)).progression).toEqual({
        level: 1,
        maxLevel: 6,
        treeCount: 0,
        nextLevelAt: 1,
        unlockedAreas: [],
      });
      await t.focus(ada, [
        ['2026-08-10', 30],
        ['2026-09-10', 30],
      ]);
      const before = (await get<{ tree: TreeStateDto }>(ada, '/me/trees/current')).tree;
      await t.setNow('2026-10-08T20:00:00.000Z');
      expect((await forest(ada)).progression).toMatchObject({
        level: 2,
        treeCount: 2,
        nextLevelAt: 3,
        unlockedAreas: ['lake'],
      });
      expect((await get<{ tree: TreeStateDto }>(ada, '/me/trees/current')).tree.progress).toEqual(
        before.progress,
      );
    });

    it('shows only the user’s own months', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await t.focus(ada, [['2026-09-10', 30]]);
      const bobs = await forest(bob);
      expect(bobs.items.find((item) => label(item) === '2026-09')).toEqual({
        kind: 'resting',
        year: 2026,
        month: 9,
        focusedMilliseconds: 0,
      });
      expect(bobs.summary).toEqual({ treeCount: 0, lifetimeFocusedMinutes: 0 });
      expect(await get(bob, '/me/trees/2026/9')).toEqual({ kind: 'resting', year: 2026, month: 9 });
    });

    it('requires sign-in and a time zone', async () => {
      await t.http().get('/me/forest').expect(401);
      const ada = await t.signUp('ada@example.com', null);
      const res = await t.http().get('/me/forest').set(ada.auth).expect(422);
      expect((res.body as { code: string }).code).toBe('timezone_required');
    });
  });

  describe('forest progression', () => {
    const progression = async (user: User) => (await forest(user)).progression;
    const archiveMonths = async (user: User, dates: string[]) => {
      await t.focus(
        user,
        dates.map((date) => [date, 30] as [string, number]),
      );
      await forest(user);
    };

    it('unlocks an area when its level is reached, and keeps it when thresholds rise', async () => {
      const ada = await t.signUp('ada@example.com');
      await archiveMonths(ada, ['2026-08-10']);
      expect(await progression(ada)).toMatchObject({ level: 2, unlockedAreas: ['lake'] });

      await t.activateConfig({ 'forest.levelThresholds': [5, 10, 15, 20, 25] });
      expect(await progression(ada)).toMatchObject({
        level: 1,
        treeCount: 1,
        nextLevelAt: 5,
        unlockedAreas: ['lake'],
      });
    });

    it('unlocks more areas when thresholds fall', async () => {
      const ada = await t.signUp('ada@example.com');
      await archiveMonths(ada, ['2026-08-10', '2026-09-10']);
      expect(await progression(ada)).toMatchObject({ level: 2, unlockedAreas: ['lake'] });
      await t.activateConfig({ 'forest.levelThresholds': [1, 2, 6, 12, 24] });
      expect(await progression(ada)).toMatchObject({
        level: 3,
        unlockedAreas: ['lake', 'mountains'],
      });
    });

    it('stores each unlock once, however many reads arrive together', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-07-10', 30],
        ['2026-08-10', 30],
        ['2026-09-10', 30],
      ]);
      const pages = await Promise.all(
        Array.from({ length: 5 }, () => t.http().get('/me/forest').set(ada.auth)),
      );
      expect(pages.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      const rows = await t.prisma.forestAreaUnlock.findMany({ where: { userId: ada.userId } });
      expect(rows.map((row) => row.areaId).sort()).toEqual(['lake', 'mountains']);
      expect(await progression(ada)).toMatchObject({
        level: 3,
        unlockedAreas: ['lake', 'mountains'],
      });
    });

    it('does not count resting months', async () => {
      const ada = await t.signUp('ada@example.com');
      await get(ada, '/me/trees/current'); // October viewed, never focused
      await t.setNow('2026-11-02T10:00:00.000Z');
      expect(await progression(ada)).toMatchObject({ level: 1, treeCount: 0, unlockedAreas: [] });
      expect(await t.prisma.forestAreaUnlock.count()).toBe(0);
    });

    it('belongs to its user', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await archiveMonths(ada, ['2026-08-10']);
      expect(await progression(bob)).toMatchObject({ level: 1, unlockedAreas: [] });
      expect(await t.prisma.forestAreaUnlock.count({ where: { userId: bob.userId } })).toBe(0);
    });
  });

  describe('forest month focus totals', () => {
    const MIN = 60_000;
    const focusOf = (page: ForestPage, month: string) =>
      page.items.find((item) => label(item) === month)?.focusedMilliseconds;

    it('gives each month its focus: the archived snapshot, the growing month so far, zero at rest', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-07-15T09:00:00.000Z');
      await t.focus(ada, [
        ['2026-07-03', 60],
        ['2026-07-04', 25],
        ['2026-09-10', 30],
      ]);
      await submitted(ada, '2026-10-06T10:00:00.000Z', 40);
      await submitted(ada, '2026-10-07T10:00:00.000Z', 15);
      const page = await forest(ada);
      expect(page.items.map((item) => [label(item), item.kind, item.focusedMilliseconds])).toEqual([
        ['2026-10', 'growing', 55 * MIN],
        ['2026-09', 'archived', 30 * MIN],
        ['2026-08', 'resting', 0],
        ['2026-07', 'archived', 85 * MIN],
      ]);
      // The archived month agrees with its Tree Details; the growing one with the current tree.
      const september = await get<{ stats: { focusedMinutes: number } }>(ada, '/me/trees/2026/9');
      expect(focusOf(page, '2026-09')).toBe(september.stats.focusedMinutes * MIN);
      const current = await get<{ stats: { focusedMinutes: number } }>(ada, '/me/trees/current');
      expect(focusOf(page, '2026-10')).toBe(current.stats.focusedMinutes * MIN);
    });

    it('keeps an archived month’s focus as it was archived when a late session arrives', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-05T10:00:00.000Z', 30);
      await t.setNow('2026-11-02T10:00:00.000Z');
      expect(focusOf(await forest(ada), '2026-10')).toBe(30 * MIN);
      // A session that started in October, synced after the month was planted.
      await submitted(ada, '2026-10-20T10:00:00.000Z', 45);
      expect(focusOf(await forest(ada), '2026-10')).toBe(30 * MIN);
      expect(focusOf(await forest(ada), '2026-11')).toBe(0);
    });

    it('keeps the field on every page, and only the user’s own focus', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-01-15T09:00:00.000Z');
      const bob = await t.signUp('bob@example.com', 'UTC', '2026-01-15T09:00:00.000Z');
      await t.focus(ada, [['2026-02-10', 50]]);
      await t.focus(bob, [['2026-02-10', 20]]);
      const pages = await allPages(ada, 4);
      const items = pages.flatMap((page) => page.items);
      expect(items.every((item) => Number.isInteger(item.focusedMilliseconds))).toBe(true);
      expect(items.find((item) => label(item) === '2026-02')?.focusedMilliseconds).toBe(50 * MIN);
      expect(focusOf(await forest(bob), '2026-02')).toBe(20 * MIN);
    });
  });

  describe('tree details', () => {
    it('shows the growing month like the current tree', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      const current = await get<Record<string, unknown>>(ada, '/me/trees/current');
      expect(await get(ada, '/me/trees/2026/10')).toEqual({
        kind: 'growing',
        year: 2026,
        month: 10,
        ...current,
      });
    });

    it('refuses months outside the forest and malformed months', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-03-10T00:00:00.000Z');
      await get(ada, '/me/trees/2026/2', 404);
      await get(ada, '/me/trees/2026/11', 404);
      await get(ada, '/me/trees/2026/13', 400);
      await get(ada, '/me/trees/26/1', 400);
      await get(ada, '/me/trees/2026/3/recap', 404);
    });
  });

  describe('highlighted note snapshot', () => {
    type Notes = { highlightedNotes: { sessionId: string; note: string }[] };
    const recapNotes = async (user: User) =>
      (await get<Notes>(user, '/me/trees/2026/10/recap')).highlightedNotes;
    const detailNotes = async (user: User) =>
      (await get<Notes>(user, '/me/trees/2026/10')).highlightedNotes;

    /** October with one highlighted and one private note, then archived. */
    async function archivedWithNotes() {
      const ada = await t.signUp('ada@example.com');
      const shown = await submitted(ada, '2026-10-05T10:00:00.000Z', 30);
      const plain = await submitted(ada, '2026-10-06T10:00:00.000Z', 30);
      await note(ada, shown.id, 'Finished the proof');
      await highlight(ada, shown.id);
      await note(ada, plain.id, 'Private thought');
      await t.setNow('2026-11-02T10:00:00.000Z');
      const expected = [{ sessionId: shown.id, note: 'Finished the proof' }];
      expect(await recapNotes(ada)).toEqual(expected);
      return { ada, shown, plain, expected };
    }

    it('keeps the note as it was at archive when the live note is edited', async () => {
      const { ada, shown, expected } = await archivedWithNotes();
      await note(ada, shown.id, 'Rewritten later');
      expect(await recapNotes(ada)).toEqual(expected);
      expect(await detailNotes(ada)).toEqual(expected);
      // History shows the live note.
      const history = await get<{ items: { id: string; note: string | null }[] }>(
        ada,
        '/me/sessions',
      );
      expect(history.items.find((item) => item.id === shown.id)?.note).toBe('Rewritten later');
    });

    it('keeps the note as it was at archive when the live note is deleted', async () => {
      const { ada, shown, expected } = await archivedWithNotes();
      await note(ada, shown.id, null);
      expect(await recapNotes(ada)).toEqual(expected);
      expect(await detailNotes(ada)).toEqual(expected);
    });

    it('keeps the snapshot when the highlight changes after archive', async () => {
      const { ada, shown, plain, expected } = await archivedWithNotes();
      await unhighlight(ada, shown.id);
      await highlight(ada, plain.id);
      expect(await recapNotes(ada)).toEqual(expected);
      expect(await detailNotes(ada)).toEqual(expected);
    });

    it('never copies a note that was not highlighted', async () => {
      const { ada } = await archivedWithNotes();
      const stored = await t.prisma.monthlyRecap.findFirstOrThrow({
        where: { userId: ada.userId },
      });
      const archive = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: ada.userId, status: 'archived' },
      });
      for (const json of [stored.content, archive.archive]) {
        expect(JSON.stringify(json)).not.toContain('Private thought');
      }
      expect(JSON.stringify(await forest(ada))).not.toContain('Finished the proof');
    });

    it('shows the same notes in Tree Details and the recap', async () => {
      const { ada } = await archivedWithNotes();
      expect(await detailNotes(ada)).toEqual(await recapNotes(ada));
    });

    it('cannot be changed by a late session or its note', async () => {
      const { ada, expected } = await archivedWithNotes();
      const late = await submitted(ada, '2026-10-20T10:00:00.000Z', 30);
      await note(ada, late.id, 'Late thought');
      await highlight(ada, late.id);
      expect(await recapNotes(ada)).toEqual(expected);
      expect(await detailNotes(ada)).toEqual(expected);
    });
  });

  describe('recap', () => {
    it('is generated at archive with the month’s story', async () => {
      const ada = await t.signUp('ada@example.com');
      // September: a 120-minute day and week, then 60 minutes the next week.
      await t.focus(ada, [
        ['2026-09-08', 120],
        ['2026-09-14', 60],
      ]);
      // October: Sunday 11 has 100 min; Monday 12 and Tuesday 13 have 70 each (weeks run Monday to Sunday).
      await t.focus(ada, [
        ['2026-10-11', 100],
        ['2026-10-12', 70],
        ['2026-10-13', 70],
      ]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      const recap = await get<Recap>(ada, '/me/trees/2026/10/recap');

      expect(recap).toMatchObject({
        year: 2026,
        month: 10,
        generatedAt: '2026-11-02T10:00:00.000Z',
        tree: { year: 2026, month: 10, status: 'archived', vitality: null },
        stats: { focusedMinutes: 240, sessionCount: 3, activeDays: 3, longestStreak: 3 },
        mostProductiveDay: { date: '2026-10-11', focusedMinutes: 100 },
        mostProductiveWeek: { weekStart: '2026-10-12', focusedMinutes: 140 },
        highlightedNotes: [],
        badges: [],
        ceremonySeenAt: null,
        recapSeenAt: null,
      });
      // The 100-minute day does not beat September's 120; the week, the month, and the streak do.
      expect(recap.newRecords).toEqual([
        { kind: 'most_focused_week', value: 140, unit: 'minutes', achievedOn: '2026-10-12' },
        { kind: 'most_focused_month', value: 240, unit: 'minutes', achievedOn: '2026-10-01' },
        { kind: 'longest_streak', value: 3, unit: 'days', achievedOn: '2026-10-13' },
      ]);
      expect(await t.prisma.monthlyRecap.count()).toBe(2); // September and October
    });

    it('takes the earliest day and week on a tie', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-14', 60],
        ['2026-10-06', 60],
      ]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      expect(await get(ada, '/me/trees/2026/10/recap')).toMatchObject({
        mostProductiveDay: { date: '2026-10-06', focusedMinutes: 60 },
        mostProductiveWeek: { weekStart: '2026-10-05', focusedMinutes: 60 },
      });
    });

    it('is read from storage, never regenerated', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [['2026-10-06', 60]]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      const recap = await get<Recap>(ada, '/me/trees/2026/10/recap');
      await submitted(ada, '2026-10-20T10:00:00.000Z', 200); // late
      await t
        .http()
        .patch(`/me/topics/${ada.topicId}`)
        .set(ada.auth)
        .send({ name: 'Renamed' })
        .expect(200);
      await t.activateConfig({ 'growth.stageThresholds': [1, 2, 3, 4, 5] });
      expect(await get(ada, '/me/trees/2026/10/recap')).toEqual(recap);
      expect(recap.stats).toMatchObject({ focusedMinutes: 60, topTopic: { name: 'Reading' } });
    });

    it('belongs to its user', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await t.focus(ada, [['2026-10-06', 60]]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/trees/2026/10/recap');
      await get(bob, '/me/trees/2026/10/recap', 404);
    });
  });
});
