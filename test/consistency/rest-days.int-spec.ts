import { ConsistencyHarness } from '../support/consistency-harness.js';

// Wednesday 7 October 2026; the week runs 5–11 October; 2 rest days a week.
const t = new ConsistencyHarness('2026-10-07T12:00:00.000Z');

interface RestDaysBody {
  restDays: { date: string }[];
  allowance: { perWeek: number; weekStart: string; used: number; remaining: number };
}

describe('rest days (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setToday('2026-10-07');
    await t.activateConfig();
  });

  const list = (auth: Record<string, string>) => t.http().get('/me/rest-days').set(auth);
  const put = (auth: Record<string, string>, date: string) =>
    t.http().put(`/me/rest-days/${date}`).set(auth);
  const remove = (auth: Record<string, string>, date: string) =>
    t.http().delete(`/me/rest-days/${date}`).set(auth);
  const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

  it('starts empty with the full allowance', async () => {
    const ada = await t.signUp('ada@example.com');
    expect((await list(ada.auth).expect(200)).body).toEqual({
      restDays: [],
      allowance: { perWeek: 2, weekStart: '2026-10-05', used: 0, remaining: 2 },
    });
  });

  it('schedules today and future dates, and lists them with the allowance', async () => {
    const ada = await t.signUp('ada@example.com');
    await put(ada.auth, '2026-10-07').expect(201);
    const res = await put(ada.auth, '2026-10-20').expect(201);
    expect(res.body).toEqual({
      restDays: [{ date: '2026-10-07' }, { date: '2026-10-20' }],
      allowance: { perWeek: 2, weekStart: '2026-10-05', used: 1, remaining: 1 },
    });
  });

  it('answers a repeated request with the same state and no duplicate', async () => {
    const ada = await t.signUp('ada@example.com');
    await put(ada.auth, '2026-10-08').expect(201);
    await put(ada.auth, '2026-10-08').expect(200);
    expect(await t.prisma.restDay.count({ where: { userId: ada.userId } })).toBe(1);
  });

  it('never schedules a past date', async () => {
    const ada = await t.signUp('ada@example.com');
    expect(codeOf(await put(ada.auth, '2026-10-06').expect(422))).toBe('rest_day_in_past');
  });

  it('uses the user’s local date to decide what is past', async () => {
    const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
    await t.setNow('2026-10-07T18:00:00.000Z'); // already 8 October there
    expect(codeOf(await put(ada.auth, '2026-10-07').expect(422))).toBe('rest_day_in_past');
    await put(ada.auth, '2026-10-08').expect(201);
  });

  it('keeps to the weekly allowance, Monday to Sunday', async () => {
    const ada = await t.signUp('ada@example.com');
    await put(ada.auth, '2026-10-08').expect(201);
    await put(ada.auth, '2026-10-11').expect(201); // Sunday, same week
    expect(codeOf(await put(ada.auth, '2026-10-09').expect(409))).toBe('rest_allowance_used');
    await put(ada.auth, '2026-10-12').expect(201); // the next week
  });

  it('follows the configured allowance and same-day rule', async () => {
    await t.activateConfig({ 'restDay.maxPerWeek': 1, 'restDay.allowSameDay': false });
    const ada = await t.signUp('ada@example.com');
    expect(codeOf(await put(ada.auth, '2026-10-07').expect(422))).toBe(
      'rest_day_today_not_allowed',
    );
    await put(ada.auth, '2026-10-08').expect(201);
    expect(codeOf(await put(ada.auth, '2026-10-09').expect(409))).toBe('rest_allowance_used');
  });

  it('never lets concurrent requests exceed the allowance', async () => {
    const ada = await t.signUp('ada@example.com');
    const dates = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const responses = await Promise.all(dates.map((date) => put(ada.auth, date)));
    expect(responses.filter((res) => res.status === 201)).toHaveLength(2);
    expect(responses.filter((res) => res.status === 409)).toHaveLength(3);
    expect(await t.prisma.restDay.count({ where: { userId: ada.userId } })).toBe(2);
  });

  it('cancels a rest day until it ends, returning it to the allowance', async () => {
    const ada = await t.signUp('ada@example.com');
    await put(ada.auth, '2026-10-07').expect(201);
    await put(ada.auth, '2026-10-08').expect(201);

    const res = await remove(ada.auth, '2026-10-07').expect(200);
    expect((res.body as RestDaysBody).allowance.remaining).toBe(1);
    await put(ada.auth, '2026-10-09').expect(201);

    await t.setToday('2026-10-09');
    expect(codeOf(await remove(ada.auth, '2026-10-08').expect(422))).toBe('rest_day_in_past');
    expect(codeOf(await remove(ada.auth, '2026-10-20').expect(404))).toBe('rest_day_not_found');
  });

  it('stays a rest day when the user focuses anyway, and the focus counts normally', async () => {
    const ada = await t.signUp('ada@example.com');
    await put(ada.auth, '2026-10-07').expect(201);
    await t.focus(ada, [['2026-10-07', 40]]);
    expect((await list(ada.auth).expect(200)).body).toMatchObject({
      restDays: [{ date: '2026-10-07' }],
    });
    expect((await t.http().get('/me/goals').set(ada.auth).expect(200)).body).toMatchObject({
      daily: { today: { date: '2026-10-07', focusedMinutes: 40, completed: true } },
    });
  });

  it.each(['2026-13-01', '2026-02-30', 'tomorrow', '2026-10-7'])(
    'rejects the date %s',
    async (date) => {
      const ada = await t.signUp('ada@example.com');
      await put(ada.auth, date).expect(400);
    },
  );

  it('keeps each user’s rest days and allowance separate', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    await put(ada.auth, '2026-10-08').expect(201);
    await put(ada.auth, '2026-10-09').expect(201);
    await put(bob.auth, '2026-10-08').expect(201);
    expect(((await list(bob.auth).expect(200)).body as RestDaysBody).restDays).toEqual([
      { date: '2026-10-08' },
    ]);
    expect(codeOf(await remove(bob.auth, '2026-10-09').expect(404))).toBe('rest_day_not_found');
  });

  it('requires sign-in', async () => {
    await t.http().get('/me/rest-days').expect(401);
    await t.http().put('/me/rest-days/2026-10-08').expect(401);
  });
});
