import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

const LOOPBACK = '127.0.0.1';

/**
 * Starts `app` on a free IPv4 loopback port and returns its base URL, for `request(url)`.
 *
 * Never pass `app.getHttpServer()` to supertest. supertest then listens on `[::]` (every address)
 * and sends to 127.0.0.1. The OS hands out that port even when another local program (an editor
 * helper, a dev server) holds 127.0.0.1 on it, and that program, being the more specific bind,
 * receives the request. The test then sees its reply: a 400, or `Parse Error: Expected HTTP/`.
 * Bound to 127.0.0.1 itself, the app cannot share its port that way.
 */
export async function listenOnLoopback(app: INestApplication): Promise<string> {
  await app.listen(0, LOOPBACK);
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return `http://${LOOPBACK}:${port}`;
}
