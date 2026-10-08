import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';
import { get, sid } from './x3-support.js';

/**
 * X3 contract capture: real answers of every Core Loop endpoint for one small scenario, made
 * deterministic (random ids, seeds, and database timestamps replaced by stable valid values) and
 * compared with `core-loop-contract.json`. The mobile repo keeps an identical copy
 * (`src/test-utils/x3/core-loop-contract.json`) that its zod schemas parse and its screens
 * render, so the two repos are tested against the same bytes. After an intended contract
 * change: `X3_UPDATE_CONTRACT=1 npm run test:int -- test/x3/contract-capture`, then copy the
 * file to the mobile repo.
 */

const FILE = fileURLToPath(new URL('./core-loop-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-09-01T00:01:00.000Z');

describe('X3 contract capture (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-01T00:01:00.000Z');
    await t.activateConfig();
  });

  it('answers the Core Loop endpoints exactly as captured for the mobile client', async () => {
    const user = await t.signUp('capture@example.com', 'UTC', '2026-08-01T00:00:00.000Z');
    const writing = sid(9_001);
    await t
      .http()
      .put(`/me/topics/${writing}`)
      .set(user.auth)
      .send({ name: 'Writing', icon: 'pen', color: 'topic.2' })
      .expect(201);
    const c: Record<string, unknown> = {};
    const put = async (startedAt: string, minutes: number, id: string, topicId = user.topicId) =>
      (await t.submit({ ...user, topicId }, startedAt, minutes, id)).body as Record<
        string,
        unknown
      >;

    await t.http().put('/me/goals/daily').set(user.auth).send({ minutes: 45 }).expect(200);
    await t
      .http()
      .put('/me/goals/weekly')
      .set(user.auth)
      .send({ type: 'focused_minutes', target: 150 })
      .expect(200);
    await t.http().put('/me/rest-days/2026-09-06').set(user.auth).expect(201);

    // September: a first session, a discarded one, a week of focus, a highlighted note.
    await t.setNow('2026-09-01T22:00:00.000Z');
    c['sessionFirst'] = await put('2026-09-01T06:00:00.000Z', 30, sid(1));
    c['sessionDiscarded'] = await put('2026-09-01T07:00:00.000Z', 3, sid(2));
    let n = 2;
    for (const day of [2, 3, 4, 5, 6, 7, 8]) {
      await t.setNow(`2026-09-0${day}T22:00:00.000Z`);
      await put(`2026-09-0${day}T06:00:00.000Z`, 50, sid(++n), day % 2 ? writing : user.topicId);
    }
    await t
      .http()
      .patch(`/me/sessions/${sid(5)}/note`)
      .set(user.auth)
      .send({ note: 'A calm, clear morning.' })
      .expect(200);
    await t
      .http()
      .put(`/me/sessions/${sid(5)}/note/highlight`)
      .set(user.auth)
      .expect(200);
    c['homeGrowing'] = await get(t, user, '/me/home');
    c['currentTree'] = await get(t, user, '/me/trees/current');
    c['goals'] = await get(t, user, '/me/goals');
    c['restDays'] = await get(t, user, '/me/rest-days');
    c['streak'] = await get(t, user, '/me/streak');

    // October: September closes; the ceremony is pending; a late September session arrives.
    await t.setNow('2026-10-02T09:00:00.000Z');
    c['homeAfterClose'] = await get(t, user, '/me/home');
    await t.setNow('2026-10-02T22:00:00.000Z');
    c['sessionOctober'] = await put('2026-10-02T06:00:00.000Z', 40, sid(50));
    c['sessionLate'] = await put('2026-09-28T06:00:00.000Z', 35, sid(51));
    c['forest'] = await get(t, user, '/me/forest');
    c['treeArchived'] = await get(t, user, '/me/trees/2026/9');
    c['treeResting'] = await get(t, user, '/me/trees/2026/8');
    c['treeGrowing'] = await get(t, user, '/me/trees/2026/10');
    c['recap'] = await get(t, user, '/me/trees/2026/9/recap');
    c['ceremonySeen'] = (
      await t.http().put('/me/trees/2026/9/ceremony-seen').set(user.auth).expect(200)
    ).body;
    c['insightsWeek'] = await get(t, user, '/me/insights/week?weekStart=2026-08-31');
    c['insightsMonth'] = await get(t, user, '/me/insights/month?year=2026&month=9');
    c['heatmap'] = await get(t, user, '/me/insights/heatmap?from=2026-08-31&to=2026-10-02');
    c['records'] = await get(t, user, '/me/insights/records');
    c['profileStats'] = await get(t, user, '/me/profile/stats');
    c['historySeptember'] = await get(t, user, '/me/sessions?month=2026-09&limit=50');
    c['historyTopic'] = await get(t, user, `/me/sessions?topicId=${writing}&limit=50`);
    c['profile'] = await get(t, user, '/me/profile');
    c['topics'] = await get(t, user, '/me/topics');

    const replace = new Map([
      [user.userId, '00000000-0000-4000-8000-0000000000aa'],
      [user.topicId, '00000000-0000-4000-8000-00000000a001'],
    ]);
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    // The capture holds no secret or account data beyond the test's own.
    expect(captured).not.toMatch(/accessToken|refreshToken|password|capture@example\.com/);

    if (process.env['X3_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
  });
});
