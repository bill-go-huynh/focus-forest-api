import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A7.1 Account and data deletion (docs/11 Privacy; Phase 7 plan, owner decision 3): a person
 * deletes their own account at once, confirmed by their password, and can first download a copy
 * of everything stored about them. Shared totals stay, anonymous; nothing of other people's
 * private data is in the copy.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
type Body = Record<string, unknown>;

describe('account deletion and export (A7.1)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-02T10:00:00.000Z');
    await t.activateConfig();
  });

  /** Ana with a session and a note, a device, friends, a block, reactions, and a report. */
  async function world() {
    const ana = await t.signUp('ana@example.com', 'Europe/Berlin', '2026-09-01T00:00:00.000Z');
    const ben = await t.signUp('ben@example.com', 'UTC', '2026-09-01T00:00:00.000Z');
    const cai = await t.signUp('cai@example.com', 'UTC', '2026-09-01T00:00:00.000Z');
    await t.http().patch('/me/profile').set(ana.auth).send({ username: 'ana' }).expect(200);
    await t.http().patch('/me/profile').set(ben.auth).send({ username: 'ben' }).expect(200);
    await t.setNow('2026-11-02T10:31:00.000Z');
    const sessionId = randomUUID();
    await t.submit(ana, '2026-11-02T10:00:00.000Z', 30, sessionId).expect(201);
    await t
      .http()
      .patch(`/me/sessions/${sessionId}/note`)
      .set(ana.auth)
      .send({ note: 'Chapter three, finally.' })
      .expect(200);
    await t
      .http()
      .put(`/me/devices/${encodeURIComponent('ExponentPushToken[ana-secret-token]')}`)
      .set(ana.auth)
      .send({ platform: 'ios' })
      .expect(200);
    await t.http().put(`/me/following/${ben.userId}`).set(ana.auth).expect(200);
    await t.http().put(`/me/following/${ana.userId}`).set(ben.auth).expect(200);
    await t.http().put(`/me/blocks/${cai.userId}`).set(ana.auth).expect(204);
    const now = t.clock.now();
    await t.prisma.block.create({
      data: { blockerId: cai.userId, blockedId: ana.userId, createdAt: now },
    });
    await t.prisma.reaction.createMany({
      data: [
        {
          reactorId: ben.userId,
          ownerId: ana.userId,
          targetType: 'forest',
          targetKey: '',
          reaction: 'heart',
          createdAt: now,
        },
        {
          reactorId: ana.userId,
          ownerId: ben.userId,
          targetType: 'forest',
          targetKey: '',
          reaction: 'sprout',
          createdAt: now,
        },
      ],
    });
    await t.prisma.report.createMany({
      data: [
        {
          id: randomUUID(),
          reporterId: ana.userId,
          targetId: cai.userId,
          category: 'behavior',
          details: 'Spam in rooms.',
          createdAt: now,
        },
        {
          id: randomUUID(),
          reporterId: cai.userId,
          targetId: ana.userId,
          category: 'bio',
          details: 'Cai thinks so.',
          createdAt: now,
        },
      ],
    });
    return { ana, ben, cai, sessionId };
  }

  const remove = (user: User, body: object) => t.http().delete('/me').set(user.auth).send(body);

  describe('export', () => {
    it('answers everything stored about the person, as a file', async () => {
      const { ana, ben, cai, sessionId } = await world();
      const res = await t.http().get('/me/export').set(ana.auth).expect(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="focus-forest-export.json"',
      );
      const data = res.body as Body;
      expect(Object.keys(data)).toEqual([
        'exportedAt',
        'account',
        'preferences',
        'topics',
        'sessions',
        'goals',
        'trees',
        'rewards',
        'social',
        'together',
        'notifications',
        'analytics',
        'moderation',
      ]);
      expect(data['exportedAt']).toBe('2026-11-02T10:31:00.000Z');
      expect(data['account']).toMatchObject({
        id: ana.userId,
        email: 'ana@example.com',
        username: 'ana',
        timezone: 'Europe/Berlin',
      });
      expect((data['sessions'] as Body[]).map((s) => [s['id'], s['note']])).toEqual([
        [sessionId, 'Chapter three, finally.'],
      ]);
      const social = data['social'] as Record<string, Body[]>;
      expect(social['following']).toEqual([
        { userId: ben.userId, createdAt: expect.any(String) as string },
      ]);
      expect(social['followers']).toEqual([
        { userId: ben.userId, createdAt: expect.any(String) as string },
      ]);
      // The people Ana blocked, never who blocked her.
      expect(social['blocked']).toEqual([
        { userId: cai.userId, createdAt: expect.any(String) as string },
      ]);
      expect(social['reactionsGiven']).toEqual([
        expect.objectContaining({ toUserId: ben.userId, reaction: 'sprout' }),
      ]);
      expect(social['reactionsReceived']).toEqual([
        expect.objectContaining({ fromUserId: ben.userId, reaction: 'heart' }),
      ]);
      // The reports Ana filed, never those about her (they would name the reporter).
      expect((data['moderation'] as Record<string, Body[]>)['reportsFiled']).toEqual([
        expect.objectContaining({ category: 'behavior', details: 'Spam in rooms.' }),
      ]);
      // Events and the Community Tree were removed (owner, 2026-10-22): nothing to export.
      expect(Object.keys(data['together'] as Body)).not.toContain('communityContributions');
      expect(Object.keys(data['together'] as Body)).not.toContain('events');
      expect((data['notifications'] as Record<string, Body[]>)['devices']).toEqual([
        {
          platform: 'ios',
          appVersion: null,
          registeredAt: expect.any(String) as string,
          lastSeenAt: expect.any(String) as string,
        },
      ]);

      const text = JSON.stringify(data);
      for (const secret of [
        'passwordHash',
        'tokenHash',
        'ana-secret-token',
        'Cai thinks so.',
        'ben@example.com',
        'cai@example.com',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('is only ever the signed-in person’s own', async () => {
      await t.http().get('/me/export').expect(401);
    });
  });

  describe('deletion', () => {
    it('needs the password', async () => {
      const { ana } = await world();
      expect((await remove(ana, {}).expect(400)).body).toMatchObject({ statusCode: 400 });
      expect((await remove(ana, { password: 'not it at all' }).expect(403)).body).toMatchObject({
        code: 'password_incorrect',
      });
      expect(await t.prisma.user.count({ where: { id: ana.userId } })).toBe(1);
    });

    it('erases the account and everything it owns at once; shared totals stay, anonymous', async () => {
      const { ana, ben, cai } = await world();
      await remove(ana, { password: PASSWORD }).expect(204);

      expect(await t.prisma.user.count({ where: { id: ana.userId } })).toBe(0);
      for (const count of await Promise.all([
        t.prisma.focusSession.count({ where: { userId: ana.userId } }),
        t.prisma.topic.count({ where: { userId: ana.userId } }),
        t.prisma.monthlyTree.count({ where: { userId: ana.userId } }),
        t.prisma.pushDevice.count({ where: { userId: ana.userId } }),
        t.prisma.refreshToken.count({ where: { userId: ana.userId } }),
        t.prisma.follow.count({
          where: { OR: [{ followerId: ana.userId }, { followeeId: ana.userId }] },
        }),
        t.prisma.block.count({
          where: { OR: [{ blockerId: ana.userId }, { blockedId: ana.userId }] },
        }),
        t.prisma.reaction.count({
          where: { OR: [{ reactorId: ana.userId }, { ownerId: ana.userId }] },
        }),
      ])) {
        expect(count).toBe(0);
      }
      // Her old tokens open nothing, and she cannot sign in again.
      await t.http().get('/me/profile').set(ana.auth).expect(401);
      await t
        .http()
        .post('/auth/sign-in')
        .send({ email: 'ana@example.com', password: PASSWORD })
        .expect(401);
      // The report she filed stays for the moderators, without her.
      expect(
        (await t.prisma.report.findFirstOrThrow({ where: { targetId: cai.userId } })).reporterId,
      ).toBeNull();
      // Ben's own data is untouched.
      await t.http().get('/me/profile').set(ben.auth).expect(200);
      // No admin audit: the person deleted their own account.
      expect(await t.prisma.adminAuditLog.count()).toBe(0);
    });

    it('frees the email for a new account', async () => {
      const { ana } = await world();
      await remove(ana, { password: PASSWORD }).expect(204);
      await t
        .http()
        .post('/auth/sign-up')
        .send({ email: 'ana@example.com', password: PASSWORD })
        .expect(201);
    });
  });
});
