import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<typeof t.signUp>>;

interface SessionBody {
  id: string;
  note: string | null;
  noteHighlighted: boolean;
}

describe('highlighted session notes (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const session = async (user: User) =>
    (await t.submit(user, '2026-10-07T10:00:00.000Z', 30).expect(201)).body as SessionBody;
  const note = (user: User, id: string, text: string | null) =>
    t.http().patch(`/me/sessions/${id}/note`).set(user.auth).send({ note: text });
  const highlight = (user: User, id: string) =>
    t.http().put(`/me/sessions/${id}/note/highlight`).set(user.auth);
  const unhighlight = (user: User, id: string) =>
    t.http().delete(`/me/sessions/${id}/note/highlight`).set(user.auth);
  const stored = async (user: User, id: string) =>
    t.prisma.focusSession.findUniqueOrThrow({
      where: { userId_id: { userId: user.userId, id } },
    });

  it('is off by default, and every session response says so', async () => {
    const ada = await t.signUp('ada@example.com');
    const body = await session(ada);
    expect(body.noteHighlighted).toBe(false);
    const history = (await t.http().get('/me/sessions').set(ada.auth).expect(200)).body as {
      items: SessionBody[];
    };
    expect(history.items[0]?.noteHighlighted).toBe(false);
  });

  it('highlights and unhighlights a note, idempotently', async () => {
    const ada = await t.signUp('ada@example.com');
    const { id } = await session(ada);
    await note(ada, id, 'A good day').expect(200);

    for (let i = 0; i < 2; i += 1) {
      const res = await highlight(ada, id).expect(200);
      expect(res.body).toMatchObject({ id, note: 'A good day', noteHighlighted: true });
    }
    expect((await stored(ada, id)).noteHighlighted).toBe(true);
    // Editing the note keeps the highlight.
    expect((await note(ada, id, 'A great day').expect(200)).body).toMatchObject({
      noteHighlighted: true,
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await unhighlight(ada, id).expect(200);
      expect(res.body).toMatchObject({ id, noteHighlighted: false });
    }
  });

  it('needs a note to highlight', async () => {
    const ada = await t.signUp('ada@example.com');
    const { id } = await session(ada);
    const res = await highlight(ada, id).expect(422);
    expect((res.body as { code: string }).code).toBe('note_required');
    expect((await stored(ada, id)).noteHighlighted).toBe(false);
  });

  it('clears the highlight with the note', async () => {
    const ada = await t.signUp('ada@example.com');
    const { id } = await session(ada);
    await note(ada, id, 'A good day').expect(200);
    await highlight(ada, id).expect(200);
    expect((await note(ada, id, '   ').expect(200)).body).toMatchObject({
      note: null,
      noteHighlighted: false,
    });
    expect(await stored(ada, id)).toMatchObject({ note: null, noteHighlighted: false });
  });

  it('only touches the user’s own sessions', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    const { id } = await session(ada);
    await note(ada, id, 'Mine').expect(200);
    await highlight(bob, id).expect(404);
    expect((await stored(ada, id)).noteHighlighted).toBe(false);
    await highlight(ada, id).expect(200);
    await unhighlight(bob, id).expect(404);
    expect((await stored(ada, id)).noteHighlighted).toBe(true);
    await highlight(ada, randomUUID()).expect(404);
  });

  it('keeps a highlighted note non-empty in the database too', async () => {
    const ada = await t.signUp('ada@example.com');
    const { id } = await session(ada);
    await expect(
      t.prisma.focusSession.update({
        where: { userId_id: { userId: ada.userId, id } },
        data: { noteHighlighted: true },
      }),
    ).rejects.toThrow();
  });

  it('does not change what a replay of the submission answers, beyond the note fields', async () => {
    const ada = await t.signUp('ada@example.com');
    const id = randomUUID();
    await t.submit(ada, '2026-10-07T10:00:00.000Z', 30, id).expect(201);
    await note(ada, id, 'A good day').expect(200);
    await highlight(ada, id).expect(200);
    const replay = await t.submit(ada, '2026-10-07T10:00:00.000Z', 30, id).expect(200);
    expect(replay.body).toMatchObject({ id, note: 'A good day', noteHighlighted: true });
  });
});
