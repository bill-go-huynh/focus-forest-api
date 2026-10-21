import { ExpoPushTransport } from './expo-push-transport.js';
import type { PushMessage } from './push-transport.js';

const message = (n: number): PushMessage => ({
  to: `ExponentPushToken[token${n}]`,
  title: 'Time to focus',
  body: 'Your tree is ready when you are.',
  data: { link: '/', category: 'scheduledFocusReminder', recipient: 'user-1' },
});

function fakeFetch(answer: (body: unknown, url: string) => unknown) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(init.body as string);
    calls.push({ url, init, body });
    return Promise.resolve(
      new Response(JSON.stringify(answer(body, url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe('ExpoPushTransport', () => {
  it('sends messages in chunks of 100 and answers a ticket for each, in order', async () => {
    const { fetch, calls } = fakeFetch((body) => ({
      data: (body as PushMessage[]).map((m) =>
        m.to.endsWith('[token3]')
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: `ticket-${m.to}` },
      ),
    }));
    const transport = new ExpoPushTransport({ fetch, accessToken: null });

    const tickets = await transport.send(Array.from({ length: 150 }, (_, i) => message(i)));

    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 50]);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0]!.body).toEqual(
      expect.arrayContaining([
        {
          to: 'ExponentPushToken[token0]',
          title: 'Time to focus',
          body: 'Your tree is ready when you are.',
          data: { link: '/', category: 'scheduledFocusReminder', recipient: 'user-1' },
          sound: 'default',
          priority: 'normal',
        },
      ]),
    );
    expect(tickets).toHaveLength(150);
    expect(tickets[0]).toEqual({ status: 'ok', id: 'ticket-ExponentPushToken[token0]' });
    expect(tickets[3]).toEqual({ status: 'error', error: 'DeviceNotRegistered' });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBeNull();
  });

  it('signs requests with the access token when one is set', async () => {
    const { fetch, calls } = fakeFetch(() => ({ data: [{ status: 'ok', id: 'a' }] }));
    await new ExpoPushTransport({ fetch, accessToken: 'secret' }).send([message(1)]);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer secret');
  });

  it('answers an error ticket for every message when the request fails', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('busy', { status: 503 })),
    ) as unknown as typeof globalThis.fetch;
    const tickets = await new ExpoPushTransport({ fetch, accessToken: null }).send([
      message(1),
      message(2),
    ]);
    expect(tickets).toEqual([
      { status: 'error', error: 'RequestFailed' },
      { status: 'error', error: 'RequestFailed' },
    ]);
  });

  it('reads receipts', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      data: {
        a: { status: 'ok' },
        b: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      },
    }));
    const receipts = await new ExpoPushTransport({ fetch, accessToken: null }).receipts(['a', 'b']);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(calls[0]!.body).toEqual({ ids: ['a', 'b'] });
    expect(receipts).toEqual({
      a: { status: 'ok' },
      b: { status: 'error', error: 'DeviceNotRegistered' },
    });
  });

  it('sends nothing for no messages', async () => {
    const { fetch, calls } = fakeFetch(() => ({ data: [] }));
    expect(await new ExpoPushTransport({ fetch, accessToken: null }).send([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
