import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { listenOnLoopback } from './support/loopback-http.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let url: string;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health', () => {
    return request(url).get('/health').expect(200).expect({ status: 'ok' });
  });
});
