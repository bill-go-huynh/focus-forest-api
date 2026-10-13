import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { HealthController } from '../../src/health/health.controller.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { listenOnLoopback } from './loopback-http.js';

/** Resolves to 'listening' or the bind error code, and keeps the server for cleanup. */
function tryListen(servers: net.Server[], port: number, host: string): Promise<string> {
  // Another local program on the same port: it answers in a language that is not HTTP.
  const server = net.createServer((socket) => {
    socket.end('\u0000not http\r\n', () => socket.destroy());
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    server.listen(port, host, () => resolve('listening'));
  });
}

describe('listenOnLoopback', () => {
  let app: INestApplication;
  let others: net.Server[];

  beforeEach(async () => {
    // Liveness only: the readiness check's database is not needed here.
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    others = [];
  });

  afterEach(async () => {
    await Promise.all(others.filter((s) => s.listening).map((s) => new Promise((r) => s.close(r))));
    await app.close();
  });

  it('serves the app on the IPv4 loopback', async () => {
    const url = await listenOnLoopback(app);

    expect(new URL(url).hostname).toBe('127.0.0.1');
    await request(url).get('/health').expect(200, { status: 'ok' });
  });

  it('keeps its port from other local programs, so every request reaches the app', async () => {
    const url = await listenOnLoopback(app);
    const port = Number(new URL(url).port);

    // The flake: a program bound to 127.0.0.1 on the app's port received the test's request.
    const onLoopback = await tryListen(others, port, '127.0.0.1');
    // A wildcard bind may or may not be allowed by the OS; either way it must not get the traffic.
    await tryListen(others, port, '::');

    await request(url).get('/health').expect(200, { status: 'ok' });
    expect(onLoopback).toBe('EADDRINUSE');
  });
});

describe('integration and e2e tests', () => {
  const testRoot = join(import.meta.dirname, '..');
  const specs = readdirSync(testRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(int-|e2e-)?spec\.ts$/.test(file))
    .filter((file) => !file.startsWith('support'));

  it('are all scanned, integration and e2e alike', () => {
    expect(specs).toEqual(
      expect.arrayContaining(['health.e2e-spec.ts', join('topics', 'topics.int-spec.ts')]),
    );
  });

  // supertest(app.getHttpServer()) listens on [::] and then sends to 127.0.0.1, where another
  // program may be listening on the same port (see loopback-http.ts).
  it('never hand the Nest HTTP server to supertest', () => {
    const offenders = specs.filter((file) =>
      /request\(\s*[\w.]*getHttpServer\(\)/.test(readFileSync(join(testRoot, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
