import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';

describe('session rules (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;
  let config: ProductConfigService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
    config = app.get(ProductConfigService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(url);

  async function signUp(): Promise<string> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email: 'ada@example.com', password: 'correct horse battery staple' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  // Every test starts with empty tables, so each one activates the version it needs.
  async function activate(minValidMinutes: number, maxPauseMinutes: number): Promise<number> {
    const created = await config.createVersion(
      { 'session.minValidMinutes': minValidMinutes, 'session.maxPauseMinutes': maxPauseMinutes },
      'test',
    );
    await config.activate(created.version);
    return created.version;
  }

  const get = (token: string) =>
    http().get('/session-rules').set('Authorization', `Bearer ${token}`);

  it('requires a signed-in user', async () => {
    await activate(5, 30);
    await http().get('/session-rules').expect(401);
  });

  it('returns only the session rules of the active version', async () => {
    const version = await activate(5, 30);
    const token = await signUp();

    const res = await get(token).expect(200);

    expect(res.body).toStrictEqual({ version, minValidMinutes: 5, maxPauseMinutes: 30 });
  });

  it('follows the active version when it changes', async () => {
    await activate(5, 30);
    const token = await signUp();
    const next = await activate(10, 45);

    const res = await get(token).expect(200);

    expect(res.body).toStrictEqual({ version: next, minValidMinutes: 10, maxPauseMinutes: 45 });
  });
});
