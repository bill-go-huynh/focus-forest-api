import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

// Wednesday 7 October 2026, 20:00 UTC.
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<typeof t.signUp>>;

interface Item {
  id: string;
  localDate: string;
  status: string;
  startedAt: string;
  topic: { id: string; status: string };
}

interface Page {
  items: Item[];
  nextCursor: string | null;
}

describe('focus history filters (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const page = async (user: User, query: string, status = 200) =>
    (await t.http().get(`/me/sessions${query}`).set(user.auth).expect(status)).body as Page;
  const dates = async (user: User, query: string) =>
    (await page(user, query)).items.map((item) => item.localDate);

  /** Every page of a filtered history, following nextCursor with the same filters. */
  async function all(user: User, filters: string, limit = 2): Promise<Item[]> {
    const items: Item[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?${filters}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const result = await page(user, query);
      items.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    return items;
  }

  async function withHistory() {
    const ada = await t.signUp('ada@example.com');
    const mathsId = randomUUID();
    await t
      .http()
      .put(`/me/topics/${mathsId}`)
      .set(ada.auth)
      .send({ name: 'Maths', icon: 'book', color: 'topic.2' })
      .expect(201);
    const maths = { ...ada, topicId: mathsId };
    await t.focus(ada, [
      ['2026-09-27', 30], // Sunday
      ['2026-09-28', 30], // Monday
      ['2026-09-30', 2, 'discarded'],
      ['2026-10-01', 30],
      ['2026-10-04', 30],
      ['2026-10-05', 30],
    ]);
    await t.focus(maths, [
      ['2026-09-29', 40],
      ['2026-10-02', 40],
    ]);
    await t.http().post(`/me/topics/${mathsId}/archive`).set(ada.auth).expect(200);
    return { ada, maths };
  }

  it('filters by local date range, newest first, every status shown', async () => {
    const { ada } = await withHistory();
    expect(await dates(ada, '?from=2026-09-29&to=2026-10-01')).toEqual([
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
    ]);
    expect(await dates(ada, '?from=2026-10-04')).toEqual(['2026-10-05', '2026-10-04']);
    expect(await dates(ada, '?to=2026-09-27')).toEqual(['2026-09-27']);
  });

  it('filters by a Monday-to-Sunday week and by attributed month', async () => {
    const { ada } = await withHistory();
    expect(await dates(ada, '?week=2026-09-28')).toEqual([
      '2026-10-04',
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
      '2026-09-28',
    ]);
    expect(await dates(ada, '?month=2026-09')).toEqual([
      '2026-09-30',
      '2026-09-29',
      '2026-09-28',
      '2026-09-27',
    ]);
  });

  it('filters by topic, archived ones too, and by status', async () => {
    const { ada, maths } = await withHistory();
    const items = (await page(ada, `?topicId=${maths.topicId}`)).items;
    expect(items.map((item) => [item.localDate, item.topic.status])).toEqual([
      ['2026-10-02', 'archived'],
      ['2026-09-29', 'archived'],
    ]);
    expect(await dates(ada, '?status=discarded')).toEqual(['2026-09-30']);
    expect(await dates(ada, `?status=completed&topicId=${maths.topicId}&month=2026-10`)).toEqual([
      '2026-10-02',
    ]);
  });

  it('pages through a filtered history without a gap, a repeat, or another filter’s rows', async () => {
    const { ada } = await withHistory();
    const items = await all(ada, 'from=2026-09-28&to=2026-10-04');
    expect(items.map((item) => item.localDate)).toEqual([
      '2026-10-04',
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
      '2026-09-28',
    ]);
    const starts = items.map((item) => `${item.startedAt}/${item.id}`);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it('refuses a cursor from other filters, so a filter change starts over', async () => {
    const { ada } = await withHistory();
    const first = await page(ada, '?month=2026-09&limit=1');
    const res = await t
      .http()
      .get(`/me/sessions?month=2026-10&limit=1&cursor=${first.nextCursor ?? ''}`)
      .set(ada.auth)
      .expect(400);
    expect((res.body as { code: string }).code).toBe('cursor_filters_changed');
    // An unfiltered cursor does not continue a filtered list either, and the reverse.
    const plain = await page(ada, '?limit=1');
    await page(ada, `?month=2026-09&cursor=${plain.nextCursor ?? ''}`, 400);
    await page(ada, `?cursor=${first.nextCursor ?? ''}`, 400);
  });

  it('refuses mixed or malformed filters', async () => {
    const { ada } = await withHistory();
    for (const query of [
      '?week=2026-09-29', // not a Monday
      '?week=2026-09-28&month=2026-09',
      '?from=2026-09-28&month=2026-09',
      '?from=2026-10-05&to=2026-10-01',
      '?month=2026-13',
      '?from=yesterday',
      '?topicId=maths',
      '?status=counted',
    ]) {
      await page(ada, query, 400);
    }
  });

  it('keeps the unfiltered history as it was', async () => {
    const { ada } = await withHistory();
    const items = await all(ada, '', 3);
    expect(items).toHaveLength(8);
    expect(await page(ada, '')).toMatchObject({ nextCursor: null });
  });

  it('shows only the user’s own sessions', async () => {
    const { maths } = await withHistory();
    const bob = await t.signUp('bob@example.com');
    expect((await page(bob, `?topicId=${maths.topicId}`)).items).toEqual([]);
    expect((await page(bob, '?month=2026-09')).items).toEqual([]);
  });
});
