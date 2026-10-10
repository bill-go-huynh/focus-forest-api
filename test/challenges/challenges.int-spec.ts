import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.5 Challenges (spec §15, docs/02 Challenges, docs/06 Challenge): personal, friend, and group
 * challenges from the configured templates, progress derived from counted sessions only, and no
 * penalty for not completing.
 */

const t = new ConsistencyHarness('2026-10-12T10:00:00.000Z');
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
interface Participant {
  user: { id: string; username: string | null };
  value: number;
  reached: boolean;
}
interface Challenge {
  id: string;
  template: { id: string; kind: string; measure: string; goal: string; target: number };
  startDate: string;
  endDate: string;
  phase: string;
  completedAt: string | null;
  progress: { value: number; target: number };
  participants: Participant[];
  invited: { id: string; username: string | null }[];
  you: { status: string };
}

async function person(name: string): Promise<User> {
  const user = await t.signUp(`${name}@example.com`);
  await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
  return user;
}
async function friends(a: User, b: User) {
  await t.http().put(`/me/following/${b.userId}`).set(a.auth).expect(200);
  await t.http().put(`/me/following/${a.userId}`).set(b.auth).expect(200);
}
const create = (user: User, templateId: string, invite?: string[]) =>
  t
    .http()
    .post('/me/challenges')
    .set(user.auth)
    .send({ templateId, ...(invite && { invite }) });
const one = async (user: User, id: string) =>
  (await t.http().get(`/me/challenges/${id}`).set(user.auth).expect(200)).body as Challenge;
const mine = async (user: User) =>
  (await t.http().get('/me/challenges').set(user.auth).expect(200)).body as {
    current: Challenge[];
    invitations: Challenge[];
    finished: Challenge[];
  };
const act = (user: User, id: string, action: 'accept' | 'decline' | 'leave') =>
  t.http().post(`/me/challenges/${id}/${action}`).set(user.auth);

describe('Challenges (A5.5, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-12T10:00:00.000Z');
    await t.activateConfig();
  });

  it('lists the configured templates: cooperative and consistency formats only', async () => {
    const ada = await person('ada');
    const res = await t.http().get('/challenge-templates').set(ada.auth).expect(200);
    const items = (res.body as { items: { id: string; goal: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([
      'seven-days-thirty-minutes',
      'ten-hours-week',
      'thirty-sessions-month',
      'steady-week-together',
      'ten-hours-each',
      'team-fifty-hours',
    ]);
    expect(new Set(items.map((item) => item.goal))).toEqual(new Set(['each', 'shared']));
  });

  describe('personal', () => {
    it('starts today and counts only counted focus in its window', async () => {
      const ada = await person('ada');
      // Before the window: never counted.
      await t.focus(ada, [['2026-10-11', 120]]);
      const created = await create(ada, 'ten-hours-week').expect(201);
      const challenge = created.body as Challenge;
      expect(challenge).toMatchObject({
        template: {
          id: 'ten-hours-week',
          kind: 'personal',
          measure: 'focus_minutes',
          goal: 'each',
          target: 600,
          dailyMinutes: 0,
          days: 7,
        },
        startDate: '2026-10-12',
        endDate: '2026-10-18',
        phase: 'active',
        completedAt: null,
        progress: { value: 0, target: 600 },
        invited: [],
        you: { status: 'joined' },
      });
      await t.focus(ada, [
        ['2026-10-12', 200],
        ['2026-10-13', 100, 'discarded'],
        ['2026-10-14', 250],
      ]);
      expect((await one(ada, challenge.id)).progress).toEqual({ value: 450, target: 600 });

      await t.focus(ada, [['2026-10-15', 150]]);
      await t.setNow('2026-10-15T12:00:00.000Z');
      const done = await one(ada, challenge.id);
      expect(done).toMatchObject({
        phase: 'completed',
        completedAt: '2026-10-15T12:00:00.000Z',
        progress: { value: 600 },
      });
      // Once completed, it stays completed: reading later never moves the time.
      await t.setNow('2026-10-20T12:00:00.000Z');
      expect(await one(ada, challenge.id)).toMatchObject({
        phase: 'completed',
        completedAt: '2026-10-15T12:00:00.000Z',
      });
    });

    it('counts days with the daily amount, and sessions', async () => {
      const ada = await person('ada');
      const days = (await create(ada, 'seven-days-thirty-minutes').expect(201)).body as Challenge;
      const sessions = (await create(ada, 'thirty-sessions-month').expect(201)).body as Challenge;
      await t.focus(ada, [
        ['2026-10-12', 30],
        ['2026-10-13', 20],
        ['2026-10-13', 20],
        ['2026-10-14', 29],
      ]);
      expect((await one(ada, days.id)).progress).toEqual({ value: 2, target: 7 });
      expect((await one(ada, sessions.id)).progress).toEqual({ value: 4, target: 30 });
    });

    it('simply ends when not reached, with no penalty, and can be left', async () => {
      const ada = await person('ada');
      const c = (await create(ada, 'ten-hours-week').expect(201)).body as Challenge;
      await t.focus(ada, [['2026-10-12', 60]]);
      await t.setNow('2026-10-19T12:00:00.000Z');
      expect(await one(ada, c.id)).toMatchObject({ phase: 'ended', completedAt: null });
      const lists = await mine(ada);
      expect(lists.current).toEqual([]);
      expect(lists.finished.map((x) => x.id)).toEqual([c.id]);
      expect(JSON.stringify(lists)).not.toMatch(/fail|missed|lost/i);

      const other = (await create(ada, 'thirty-sessions-month').expect(201)).body as Challenge;
      await act(ada, other.id, 'leave').expect(204);
      await t.http().get(`/me/challenges/${other.id}`).set(ada.auth).expect(404);
    });

    it('refuses unknown templates and invitations', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await friends(ada, bob);
      const unknown = await create(ada, 'race-to-ten').expect(422);
      expect(unknown.body).toMatchObject({ code: 'unknown_template' });
      const personal = await create(ada, 'ten-hours-week', [bob.userId]).expect(422);
      expect(personal.body).toMatchObject({ code: 'personal_challenge' });
    });
  });

  describe('with friends', () => {
    it('invites friends, who accept; every participant must reach the target', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await friends(ada, bob);
      const c = (await create(ada, 'ten-hours-each', [bob.userId]).expect(201)).body as Challenge;
      expect(c.invited.map((u) => u.username)).toEqual(['bob']);

      const invitations = (await mine(bob)).invitations;
      expect(invitations.map((x) => [x.id, x.you.status])).toEqual([[c.id, 'invited']]);
      await act(bob, c.id, 'accept').expect(200);

      await t.focus(ada, [['2026-10-12', 600]]);
      await t.focus(bob, [['2026-10-13', 400]]);
      const half = await one(bob, c.id);
      expect(half).toMatchObject({ phase: 'active', progress: { value: 400, target: 600 } });
      expect(half.participants.map((p) => [p.user.username, p.value, p.reached])).toEqual([
        ['ada', 600, true],
        ['bob', 400, false],
      ]);
      await t.focus(bob, [['2026-10-14', 200]]);
      expect((await one(ada, c.id)).phase).toBe('completed');
    });

    it('adds everyone up for a group goal', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(ada, bob);
      await friends(ada, cyd);
      const c = (await create(ada, 'team-fifty-hours', [bob.userId, cyd.userId]).expect(201))
        .body as Challenge;
      await act(bob, c.id, 'accept').expect(200);
      await t.focus(ada, [
        ['2026-10-12', 750],
        ['2026-10-13', 750],
      ]);
      await t.focus(bob, [['2026-10-12', 1000]]);
      // Cyd has not accepted: her focus is not part of the challenge.
      await t.focus(cyd, [['2026-10-12', 900]]);
      expect((await one(ada, c.id)).progress).toEqual({ value: 2500, target: 3000 });
      await act(cyd, c.id, 'accept').expect(200);
      expect(await one(ada, c.id)).toMatchObject({
        phase: 'completed',
        progress: { value: 3400, target: 3000 },
      });
    });

    it('invites only friends, never past a block, within the size', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const fan = await person('fan');
      await friends(ada, bob);
      await t.http().put(`/me/following/${ada.userId}`).set(fan.auth).expect(200);
      const notFriend = await create(ada, 'ten-hours-each', [fan.userId]).expect(422);
      expect(notFriend.body).toMatchObject({ code: 'not_a_friend' });
      // Following someone who does not follow back is not a friendship either.
      const idol = await person('idol');
      await t.http().put(`/me/following/${idol.userId}`).set(ada.auth).expect(200);
      await create(ada, 'ten-hours-each', [idol.userId]).expect(422);
      const c = (await create(ada, 'ten-hours-each').expect(201)).body as Challenge;
      await friends(ada, cyd);
      await t.http().put(`/me/blocks/${ada.userId}`).set(cyd.auth).expect(204);
      const blocked = await t
        .http()
        .post(`/me/challenges/${c.id}/invite`)
        .set(ada.auth)
        .send({ userIds: [cyd.userId] })
        .expect(422);
      expect(blocked.body).toMatchObject({ code: 'not_a_friend' });
      await t
        .http()
        .post(`/me/challenges/${c.id}/invite`)
        .set(ada.auth)
        .send({ userIds: [bob.userId] })
        .expect(200);
      await t
        .http()
        .post(`/me/challenges/${c.id}/invite`)
        .set(ada.auth)
        .send({ userIds: [bob.userId] })
        .expect(200);
      expect((await one(ada, c.id)).invited.map((u) => u.username)).toEqual(['bob']);

      const friendsOfAda: User[] = [];
      for (const name of ['dee', 'eve', 'fay', 'gus']) {
        const f = await person(name);
        await friends(ada, f);
        friendsOfAda.push(f);
      }
      // Five places: Ada, Bob invited, and three more.
      const full = await t
        .http()
        .post(`/me/challenges/${c.id}/invite`)
        .set(ada.auth)
        .send({ userIds: friendsOfAda.map((f) => f.userId) })
        .expect(409);
      expect(full.body).toMatchObject({ code: 'challenge_full' });
    });

    it('lets an invitee decline and a participant leave, without a trace or penalty', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(ada, bob);
      await friends(ada, cyd);
      const c = (await create(ada, 'steady-week-together', [bob.userId, cyd.userId]).expect(201))
        .body as Challenge;
      // An invitee cannot invite others; only members can.
      await t
        .http()
        .post(`/me/challenges/${c.id}/invite`)
        .set(bob.auth)
        .send({ userIds: [ada.userId] })
        .expect(404);
      await act(bob, c.id, 'decline').expect(204);
      await t.http().get(`/me/challenges/${c.id}`).set(bob.auth).expect(404);
      await act(cyd, c.id, 'accept').expect(200);
      // Declining is for invitations: a member leaves instead, and stays until then.
      await act(cyd, c.id, 'decline').expect(404);
      expect((await one(ada, c.id)).participants.map((p) => p.user.username)).toEqual([
        'ada',
        'cyd',
      ]);
      await act(cyd, c.id, 'leave').expect(204);
      const seen = await one(ada, c.id);
      expect(seen.participants.map((p) => p.user.username)).toEqual(['ada']);
      expect(seen.invited).toEqual([]);
      expect(JSON.stringify(seen)).not.toMatch(/declin|left|quit/i);
      await act(bob, c.id, 'accept').expect(404);
    });

    it('cannot be joined once finished, and strangers never see it', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const eve = await person('eve');
      await friends(ada, bob);
      const c = (await create(ada, 'ten-hours-each', [bob.userId]).expect(201)).body as Challenge;
      await t.http().get(`/me/challenges/${c.id}`).set(eve.auth).expect(404);
      await act(eve, c.id, 'accept').expect(404);
      await t.setNow('2026-10-26T12:00:00.000Z');
      const late = await act(bob, c.id, 'accept').expect(409);
      expect(late.body).toMatchObject({ code: 'challenge_finished' });
    });

    it('hides a blocked participant from the other, while their focus still counts', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(ada, bob);
      await friends(ada, cyd);
      const c = (await create(ada, 'team-fifty-hours', [bob.userId, cyd.userId]).expect(201))
        .body as Challenge;
      await act(bob, c.id, 'accept').expect(200);
      await act(cyd, c.id, 'accept').expect(200);
      await t.http().put(`/me/blocks/${cyd.userId}`).set(bob.auth).expect(204);
      await t.focus(cyd, [['2026-10-12', 100]]);
      const asBob = await one(bob, c.id);
      expect(asBob.participants.map((p) => p.user.username)).toEqual(['ada', 'bob']);
      expect(asBob.progress.value).toBe(100);
    });
  });

  it('keeps a challenge going after its creator deletes their account', async () => {
    const ada = await person('ada');
    const bob = await person('bob');
    await friends(ada, bob);
    const c = (await create(ada, 'ten-hours-each', [bob.userId]).expect(201)).body as Challenge;
    await act(bob, c.id, 'accept').expect(200);
    await t.prisma.user.delete({ where: { id: ada.userId } });
    expect((await one(bob, c.id)).participants.map((p) => p.user.username)).toEqual(['bob']);
  });

  it('copies the template at creation: a configuration change is never retroactive', async () => {
    const ada = await person('ada');
    const c = (await create(ada, 'ten-hours-week').expect(201)).body as Challenge;
    await t.activateConfig({
      'challenge.templates': [
        {
          id: 'ten-hours-week',
          kind: 'personal',
          measure: 'focus_minutes',
          goal: 'each',
          target: 1200,
          dailyMinutes: 0,
          days: 7,
          maxParticipants: 1,
        },
      ],
    });
    expect((await one(ada, c.id)).progress.target).toBe(600);
    expect(
      ((await create(ada, 'ten-hours-week').expect(201)).body as Challenge).progress.target,
    ).toBe(1200);
  });
});
