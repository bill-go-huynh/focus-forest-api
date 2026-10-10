import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/** A5.4: the database keeps room places consistent even without the service. */
describe('rooms schema (A5.4, PostgreSQL)', () => {
  const t = new ConsistencyHarness('2026-10-10T10:00:00.000Z');
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(() => t.activateConfig());

  it('links a completion only to its own session, from someone who started with the room', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    const now = new Date('2026-10-10T10:00:00.000Z');
    const room = await t.prisma.focusRoom.create({
      data: {
        code: 'ABCDEF',
        name: 'Study',
        durationMinutes: 25,
        maxParticipants: 4,
        visibility: 'private',
        status: 'in_session',
        createdAt: now,
        startsAt: now,
      },
    });
    await t.focus(ada, [['2026-10-10', 25]]);
    await t.focus(bob, [['2026-10-10', 25]]);
    const [adaSession] = await t.prisma.focusSession.findMany({ where: { userId: ada.userId } });
    const [bobSession] = await t.prisma.focusSession.findMany({ where: { userId: bob.userId } });
    const place = (userId: string, data: Record<string, unknown>) =>
      t.prisma.roomParticipant.create({
        data: { roomId: room.id, userId, joinedAt: now, ...data },
      });

    // A completion time without a session, or the other way round.
    await expect(place(ada.userId, { inSession: true, completedAt: now })).rejects.toThrow();
    await expect(
      place(ada.userId, { inSession: true, sessionId: adaSession!.id }),
    ).rejects.toThrow();
    // Not started with the room.
    await expect(
      place(ada.userId, { sessionId: adaSession!.id, completedAt: now }),
    ).rejects.toThrow();
    // Someone else's session.
    await expect(
      place(ada.userId, { inSession: true, sessionId: bobSession!.id, completedAt: now }),
    ).rejects.toThrow();
    await expect(
      place(ada.userId, { inSession: true, sessionId: randomUUID(), completedAt: now }),
    ).rejects.toThrow();
    await place(ada.userId, { inSession: true, sessionId: adaSession!.id, completedAt: now });
  });

  it('refuses malformed rooms', async () => {
    const now = new Date('2026-10-10T10:00:00.000Z');
    const room = (data: Record<string, unknown>) =>
      t.prisma.focusRoom.create({
        data: {
          code: 'ABCDEF',
          name: 'Study',
          durationMinutes: 25,
          maxParticipants: 4,
          visibility: 'private',
          createdAt: now,
          ...data,
        },
      });
    for (const data of [
      { code: 'ABCDE0' },
      { name: '' },
      { durationMinutes: 4 },
      { maxParticipants: 11 },
      { status: 'in_session' },
      { startsAt: now },
      { status: 'closed' },
    ]) {
      await expect(room(data)).rejects.toThrow();
    }
    await room({});
  });
});
