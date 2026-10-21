/**
 * Where push notifications go. Production uses Expo's push service when `PUSH_PROVIDER=expo`
 * (owner decision 5: until the app has an EAS project, nothing is delivered and each attempt is
 * recorded as failed with `PushDisabled`). Tests use the recording transport.
 */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** `recipient` is the user it was for, so a phone opens `link` only for that account. */
  data: { link: string; category: string; recipient: string };
}

export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; error: string };
export type PushReceipt = { status: 'ok' } | { status: 'error'; error: string };

export abstract class PushTransport {
  /** One ticket per message, in order. */
  abstract send(messages: PushMessage[]): Promise<PushTicket[]>;
  abstract receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

/** No provider configured: every message fails as `PushDisabled`. */
export class DisabledPushTransport extends PushTransport {
  send(messages: PushMessage[]): Promise<PushTicket[]> {
    return Promise.resolve(messages.map(() => ({ status: 'error', error: 'PushDisabled' })));
  }

  receipts(): Promise<Record<string, PushReceipt>> {
    return Promise.resolve({});
  }
}

/** Keeps what was sent, and answers errors it was told to (tests). */
export class RecordingPushTransport extends PushTransport {
  readonly messages: PushMessage[] = [];
  private readonly ticketErrors = new Map<string, string>();
  private readonly receiptErrors = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private next = 0;

  send(messages: PushMessage[]): Promise<PushTicket[]> {
    return Promise.resolve(
      messages.map((message): PushTicket => {
        const error = this.ticketErrors.get(message.to);
        if (error) return { status: 'error', error };
        this.messages.push(message);
        this.next += 1;
        const id = `ticket-${this.next}`;
        this.tokens.set(id, message.to);
        return { status: 'ok', id };
      }),
    );
  }

  receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Promise.resolve(
      Object.fromEntries(
        ids.map((id) => {
          const error = this.receiptErrors.get(this.tokens.get(id) ?? '');
          return [id, error ? { status: 'error', error } : { status: 'ok' }];
        }),
      ),
    );
  }

  /** Tickets for `token` answer `error`. */
  failWith(token: string, error: string): void {
    this.ticketErrors.set(token, error);
  }

  /** Receipts for messages to `token` answer `error`. */
  receiptErrorFor(token: string, error: string): void {
    this.receiptErrors.set(token, error);
  }

  reset(): void {
    this.messages.length = 0;
    this.ticketErrors.clear();
    this.receiptErrors.clear();
    this.tokens.clear();
  }
}
