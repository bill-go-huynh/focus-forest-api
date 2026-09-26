import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });
});
