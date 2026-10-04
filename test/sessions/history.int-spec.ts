import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';
import { configValues } from '../support/product-config-values.js';

interface TopicSummary {
  id: string;
  name: string;
  icon: string;
  color: string;
  status: 'active' | 'archived';
}

interface HistoryItem {
  id: string;
  topicId: string;
  startedAt: string;
  endedAt: string;
  status: 'completed' | 'ended_early' | 'discarded';
  counted: boolean;
  localDate: string;
  note: string | null;
  topic: TopicSummary;
  [field: string]: unknown;
}

interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}

const NOW = new Date('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60_000;
const asPage = (res: request.Response): HistoryPage => res.body as HistoryPage;

describe('focus history (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Clock)
      .useValue(new FixedClock(NOW))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
  });

  beforeEach(async () => {
    const config = app.get(ProductConfigService);
    const version = await config.createVersion(configValues(), 'test');
    await config.activate(version.version);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(url);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Account {
    token: string;
    topicId: string;
  }

  async function account(email = 'ada@example.com'): Promise<Account> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    await http()
      .patch('/me/profile')
      .set(auth(token))
      .send({ timezone: 'Asia/Ho_Chi_Minh' })
      .expect(200);
    const topicId = await topic(token, 'Reading');
    return { token, topicId };
  }

  async function topic(token: string, name: string): Promise<string> {
    const id = randomUUID();
    await http()
      .put(`/me/topics/${id}`)
      .set(auth(token))
      .send({ name, icon: 'book', color: 'topic.1' })
      .expect(201);
    return id;
  }

  /** A session starting at `start`, lasting `minutes` (25 by default: completed). */
  async function session(
    who: Account,
    start: Date,
    minutes = 25,
    topicId = who.topicId,
    id: string = randomUUID(),
  ): Promise<string> {
    await http()
      .put(`/me/sessions/${id}`)
      .set(auth(who.token))
      .send({
        topicId,
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
        plannedMinutes: 25,
        pauseIntervals: [],
      })
      .expect(201);
    return id;
  }

  const history = (token: string, query = '') =>
    http().get(`/me/sessions${query}`).set(auth(token));

  /** Follows nextCursor to the end and returns every page. */
  async function allPages(token: string, limit: number): Promise<HistoryPage[]> {
    const pages: HistoryPage[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = asPage(await history(token, query).expect(200));
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor && pages.length < 50);
    return pages;
  }

  it('is empty before any session', async () => {
    const ada = await account();
    expect(asPage(await history(ada.token).expect(200))).toEqual({ items: [], nextCursor: null });
  });

  it('lists every session newest first, each with its current topic', async () => {
    const ada = await account();
    const older = await session(ada, new Date('2026-09-26T02:00:00.000Z'));
    const newer = await session(ada, new Date('2026-09-27T02:00:00.000Z'));

    const page = asPage(await history(ada.token).expect(200));

    expect(page.items.map((item) => item.id)).toEqual([newer, older]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toStrictEqual({
      id: newer,
      topicId: ada.topicId,
      startedAt: '2026-09-27T02:00:00.000Z',
      endedAt: '2026-09-27T02:25:00.000Z',
      plannedMinutes: 25,
      focusedMilliseconds: 25 * 60_000,
      pausedMilliseconds: 0,
      status: 'completed',
      counted: true,
      localDate: '2026-09-27',
      year: 2026,
      month: 9,
      note: null,
      noteHighlighted: false, // A3.4
      createdAt: expect.any(String) as string,
      topic: { id: ada.topicId, name: 'Reading', icon: 'book', color: 'topic.1', status: 'active' },
    });
  });

  it('pages through sessions across several days without duplicates or gaps', async () => {
    const ada = await account();
    // Seven sessions, every eight hours from 25 September: three local dates in Ho Chi Minh City.
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await session(ada, new Date(Date.parse('2026-09-25T01:00:00.000Z') + i * 8 * HOUR)));
    }
    const newestFirst = [...ids].reverse();

    const pages = await allPages(ada.token, 3);

    expect(pages.map((page) => page.items.length)).toEqual([3, 3, 1]);
    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(newestFirst);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.localDate)))).toEqual(
      new Set(['2026-09-25', '2026-09-26', '2026-09-27']),
    );
  });

  it('has no next page when the last page is exactly full', async () => {
    const ada = await account();
    for (let i = 0; i < 6; i++) {
      await session(ada, new Date(Date.parse('2026-09-26T01:00:00.000Z') + i * HOUR));
    }

    const pages = await allPages(ada.token, 3);

    expect(pages.map((page) => page.items.length)).toEqual([3, 3]);
    expect(pages[1]?.nextCursor).toBeNull();
  });

  it('orders sessions that start at the same instant by id, newest id first', async () => {
    const ada = await account();
    const start = new Date('2026-09-27T03:00:00.000Z');
    // A normal session and two that ended the moment they started: empty sessions contain no
    // instant, so they may share a start with another session.
    const ids = [
      await session(ada, start, 25),
      await session(ada, start, 0),
      await session(ada, start, 0),
    ];
    const byIdDescending = [...ids].sort().reverse();

    const pages = await allPages(ada.token, 1);

    expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(byIdDescending);
  });

  it('lists completed, ended early, and discarded sessions, with the current note', async () => {
    const ada = await account();
    const completed = await session(ada, new Date('2026-09-27T01:00:00.000Z'), 25);
    const endedEarly = await session(ada, new Date('2026-09-27T02:00:00.000Z'), 12);
    const discarded = await session(ada, new Date('2026-09-27T03:00:00.000Z'), 3);
    await http()
      .patch(`/me/sessions/${endedEarly}/note`)
      .set(auth(ada.token))
      .send({ note: 'Good focus' })
      .expect(200);

    const items = asPage(await history(ada.token).expect(200)).items;

    expect(items.map((item) => [item.id, item.status, item.counted, item.note])).toEqual([
      [discarded, 'discarded', false, null],
      [endedEarly, 'ended_early', true, 'Good focus'],
      [completed, 'completed', true, null],
    ]);
  });

  it('shows the topic as it is now: renamed, restyled, or archived', async () => {
    const ada = await account();
    const piano = await topic(ada.token, 'Piano');
    await session(ada, new Date('2026-09-27T01:00:00.000Z'));
    await session(ada, new Date('2026-09-27T02:00:00.000Z'), 25, piano);
    await http()
      .patch(`/me/topics/${ada.topicId}`)
      .set(auth(ada.token))
      .send({ name: 'Books', icon: 'book-open', color: 'topic.5' })
      .expect(200);
    await http().post(`/me/topics/${piano}/archive`).set(auth(ada.token)).expect(200);

    const items = asPage(await history(ada.token).expect(200)).items;

    expect(items.map((item) => item.topic)).toEqual([
      { id: piano, name: 'Piano', icon: 'book', color: 'topic.1', status: 'archived' },
      { id: ada.topicId, name: 'Books', icon: 'book-open', color: 'topic.5', status: 'active' },
    ]);
  });

  it('keeps the stored local date when the profile time zone changes', async () => {
    const ada = await account();
    // 00:30 on 27 September in Ho Chi Minh City, 13:30 on 26 September in New York.
    await session(ada, new Date('2026-09-26T17:30:00.000Z'));
    await http()
      .patch('/me/profile')
      .set(auth(ada.token))
      .send({ timezone: 'America/New_York' })
      .expect(200);

    const [item] = asPage(await history(ada.token).expect(200)).items;

    expect(item?.localDate).toBe('2026-09-27');
  });

  it("never shows another user's sessions", async () => {
    const ada = await account('ada@example.com');
    const grace = await account('grace@example.com');
    const adas = await session(ada, new Date('2026-09-27T01:00:00.000Z'));
    const graces = await session(grace, new Date('2026-09-27T01:00:00.000Z'));

    const forAda = asPage(await history(ada.token).expect(200)).items;
    const forGrace = asPage(await history(grace.token).expect(200)).items;

    expect(forAda.map((item) => item.id)).toEqual([adas]);
    expect(forGrace.map((item) => item.id)).toEqual([graces]);
    expect(forAda[0]?.topic.id).toBe(ada.topicId);
  });

  describe('limit', () => {
    it('defaults to 30', async () => {
      const ada = await account();
      for (let i = 0; i < 31; i++) {
        await session(ada, new Date(Date.parse('2026-09-25T00:00:00.000Z') + i * HOUR));
      }

      const page = asPage(await history(ada.token).expect(200));

      expect(page.items).toHaveLength(30);
      expect(page.nextCursor).not.toBeNull();
    });

    it.each(['1', '100'])('accepts %s', async (limit) => {
      const ada = await account();
      await session(ada, new Date('2026-09-27T01:00:00.000Z'));
      await session(ada, new Date('2026-09-27T02:00:00.000Z'));
      const page = asPage(await history(ada.token, `?limit=${limit}`).expect(200));
      expect(page.items).toHaveLength(Math.min(Number(limit), 2));
    });

    it.each(['0', '101', '1.5', '-1', 'ten', ''])('rejects %j', async (limit) => {
      const ada = await account();
      await history(ada.token, `?limit=${limit}`).expect(400);
    });
  });

  describe('cursor', () => {
    it.each([
      ['garbage', 'not-a-cursor!'],
      ['base64 that is not JSON', Buffer.from('hello').toString('base64url')],
      [
        'an unknown version',
        Buffer.from(
          JSON.stringify({ v: 2, s: '2026-09-27T01:00:00.000Z', i: randomUUID() }),
        ).toString('base64url'),
      ],
      ['empty', ''],
    ])('rejects %s with 400', async (_case, cursor) => {
      const ada = await account();
      await history(ada.token, `?cursor=${encodeURIComponent(cursor)}`).expect(400);
    });

    it('rejects filters and other unknown parameters', async () => {
      const ada = await account();
      await history(ada.token, `?topicId=${ada.topicId}`).expect(400);
      await history(ada.token, '?status=completed').expect(400);
    });
  });

  it('requires a signed-in user', async () => {
    await http().get('/me/sessions').expect(401);
  });
});
