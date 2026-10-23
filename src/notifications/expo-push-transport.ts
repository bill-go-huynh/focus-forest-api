import {
  type PushMessage,
  type PushReceipt,
  type PushTicket,
  PushTransport,
} from './push-transport.js';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo accepts at most 100 messages and 1000 receipt ids per request. */
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;

interface ExpoResult {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Expo's push service over HTTPS, with Node's fetch (no SDK dependency, owner decision 3). */
export class ExpoPushTransport extends PushTransport {
  constructor(
    private readonly options: { fetch: typeof globalThis.fetch; accessToken: string | null },
  ) {
    super();
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += SEND_CHUNK) {
      const chunk = messages.slice(i, i + SEND_CHUNK);
      const data = await this.post<ExpoResult[]>(
        SEND_URL,
        chunk.map((message) => ({ ...message, sound: 'default', priority: 'normal' })),
      );
      tickets.push(
        ...chunk.map((_, j): PushTicket => {
          const result = data?.[j];
          if (result?.status === 'ok' && result.id) return { status: 'ok', id: result.id };
          return { status: 'error', error: result?.details?.error ?? 'RequestFailed' };
        }),
      );
    }
    return tickets;
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const receipts: Record<string, PushReceipt> = {};
    for (let i = 0; i < ids.length; i += RECEIPT_CHUNK) {
      const data = await this.post<Record<string, ExpoResult>>(RECEIPTS_URL, {
        ids: ids.slice(i, i + RECEIPT_CHUNK),
      });
      for (const [id, result] of Object.entries(data ?? {})) {
        receipts[id] =
          result.status === 'ok'
            ? { status: 'ok' }
            : {
                status: 'error',
                error: result.details?.error ?? 'Unknown',
                // Expo's own words (with FCM's answer), for the logs (owner, 2026-10-23).
                ...(result.message ? { message: result.message } : {}),
              };
      }
    }
    return receipts;
  }

  /** The `data` of Expo's answer, or null when the request failed. */
  private async post<T>(url: string, body: unknown): Promise<T | null> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (this.options.accessToken) headers['authorization'] = `Bearer ${this.options.accessToken}`;
    try {
      const response = await this.options.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return ((await response.json()) as { data?: T }).data ?? null;
    } catch {
      return null;
    }
  }
}
