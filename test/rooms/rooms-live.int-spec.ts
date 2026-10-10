import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.4 realtime (docs/07 §6): the room channel carries state only. A client authenticates, watches
 * a room it may see, and receives the room after every change. Mutations stay REST.
 */

const t = new ConsistencyHarness('2026-10-10T10:00:00.000Z');
type Message = { type: string; [key: string]: unknown };

interface Live {
  socket: WebSocket;
  messages: Message[];
  next: (predicate: (m: Message) => boolean, ms?: number) => Promise<Message>;
  send: (message: object) => void;
}

async function connect(): Promise<Live> {
  const socket = new WebSocket(`${t.url.replace(/^http/, 'ws')}/rooms/live`);
  const messages: Message[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
  return {
    socket,
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    next: (predicate, ms = 3_000) => {
      const seen = messages.find(predicate);
      if (seen) {
        messages.splice(messages.indexOf(seen), 1);
        return Promise.resolve(seen);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message in time')), ms);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            messages.splice(messages.indexOf(m), 1);
            resolve(m);
          },
        });
      });
    },
  };
}

const token = (auth: Record<string, string>) => auth['Authorization']!.replace('Bearer ', '');

describe('Focus Together live channel (A5.4)', () => {
  const sockets: WebSocket[] = [];
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-10T10:00:00.000Z');
    await t.activateConfig();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  async function live(): Promise<Live> {
    const connection = await connect();
    sockets.push(connection.socket);
    return connection;
  }

  async function lobby() {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    const created = (
      await t
        .http()
        .post('/rooms')
        .set(ada.auth)
        .send({ name: 'Study', durationMinutes: 25, maxParticipants: 4, visibility: 'private' })
        .expect(201)
    ).body as { id: string; code: string };
    return { ada, bob, room: created };
  }

  it('pushes the room after each change to everyone watching', async () => {
    const { ada, bob, room } = await lobby();
    const channel = await live();
    channel.send({ type: 'auth', token: token(ada.auth) });
    await channel.next((m) => m.type === 'authenticated');
    channel.send({ type: 'watch', roomId: room.id });
    const first = await channel.next((m) => m.type === 'room');
    expect(first['room']).toMatchObject({ id: room.id, phase: 'lobby', you: { host: true } });

    await t.http().post('/rooms/join').set(bob.auth).send({ code: room.code }).expect(200);
    const joined = await channel.next((m) => m.type === 'room');
    expect((joined['room'] as { participants: unknown[] }).participants).toHaveLength(2);

    await t.http().put(`/rooms/${room.id}/ready`).set(bob.auth).expect(200);
    await channel.next((m) => m.type === 'room');
    await t.http().put(`/rooms/${room.id}/ready`).set(ada.auth).expect(200);
    const start = await channel.next(
      (m) => m.type === 'room' && (m['room'] as { phase: string }).phase === 'countdown',
    );
    // State only: the server's start time, never animation or presentation.
    expect(start['room']).toMatchObject({ startsAt: '2026-10-10T10:00:10.000Z' });
    expect(Object.keys(start).sort()).toEqual(['room', 'type']);
  });

  it('refuses watching before signing in, with a bad token, or a room the user cannot see', async () => {
    const { bob, room } = await lobby();
    const anonymous = await live();
    anonymous.send({ type: 'watch', roomId: room.id });
    expect(await anonymous.next((m) => m.type === 'error')).toMatchObject({
      code: 'not_authenticated',
    });
    const bad = await live();
    bad.send({ type: 'auth', token: 'nope' });
    expect(await bad.next((m) => m.type === 'error')).toMatchObject({ code: 'not_authenticated' });

    const outsider = await live();
    outsider.send({ type: 'auth', token: token(bob.auth) });
    await outsider.next((m) => m.type === 'authenticated');
    outsider.send({ type: 'watch', roomId: room.id });
    expect(await outsider.next((m) => m.type === 'error')).toMatchObject({
      code: 'room_not_found',
    });
    outsider.send({ type: 'dance' });
    expect(await outsider.next((m) => m.type === 'error')).toMatchObject({ code: 'bad_message' });
  });

  it('tells a watcher who may no longer see the room, and stops sending to them', async () => {
    const { ada, bob, room } = await lobby();
    await t.http().post('/rooms/join').set(bob.auth).send({ code: room.code }).expect(200);
    const channel = await live();
    channel.send({ type: 'auth', token: token(bob.auth) });
    await channel.next((m) => m.type === 'authenticated');
    channel.send({ type: 'watch', roomId: room.id });
    await channel.next((m) => m.type === 'room');

    await t.http().post(`/rooms/${room.id}/leave`).set(bob.auth).expect(200);
    expect(await channel.next((m) => m.type === 'gone')).toEqual({ type: 'gone', roomId: room.id });
    await t.http().put(`/rooms/${room.id}/ready`).set(ada.auth).expect(200);
    await t.http().delete(`/rooms/${room.id}/ready`).set(ada.auth).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Told once: nothing more about this room, neither the room nor "gone" again.
    expect(channel.messages).toEqual([]);
  });
});
