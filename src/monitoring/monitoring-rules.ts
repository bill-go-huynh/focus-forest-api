import { randomUUID } from 'node:crypto';

/**
 * A7.4 Error monitoring, pure: request ids and the text kept from a client's report.
 */

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const EMAIL = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[A-Za-z]{2,}/g;

/** The client's request id when well formed (so it can be found in both logs), else a new one. */
export function requestIdFrom(header: string | undefined): string {
  return header && REQUEST_ID.test(header) ? header : randomUUID();
}

/** Text from a client's report: email addresses removed, then cut to `max` characters. */
export function redact(text: string, max: number): string {
  return text.replace(EMAIL, '[email]').slice(0, max);
}
