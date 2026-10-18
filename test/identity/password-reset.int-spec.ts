import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';

/**
 * W.3 Forgot password (owner decision 2026-10-18): a 6-digit code by email sets a new password.
 * The request never says whether an email has an account. A code works once, for 15 minutes,
 * for 5 tries, and only the newest one. Setting the password signs out every other device and
 * signs this one in. An account that signs in only with Google gets an email saying so.
 */

class MemoryMailer extends Mailer {
  sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new password';
const MINUTE = 60_000;

describe('forgot password (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;
  let prisma: PrismaService;
  let clock: FixedClock;
  const mailer = new MemoryMailer();

  beforeAll(async () => {
    clock = new FixedClock(new Date());
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Mailer)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    clock.set(new Date());
    mailer.sent = [];
  });

  const http = () => request(url);
  const signUp = (email = 'ada@example.com') =>
    http().post('/auth/sign-up').send({ email, password: PASSWORD }).expect(201);
  const ask = (email = 'ada@example.com') =>
    http().post('/auth/password-reset/request').send({ email }).expect(202);
  const confirm = (code: string, email = 'ada@example.com', password = NEW_PASSWORD) =>
    http().post('/auth/password-reset/confirm').send({ email, code, password });
  /** The mail is sent after the answer, so the answer's timing says nothing. */
  const mailTo = async (to: string) => {
    await vi.waitFor(() => expect(mailer.sent.some((m) => m.to === to)).toBe(true));
    return mailer.sent.filter((m) => m.to === to).at(-1)!;
  };
  const codeIn = (message: MailMessage) => /\b(\d{6})\b/.exec(message.text)![1]!;

  it('emails a 6-digit code that sets a new password and signs in', async () => {
    await signUp();
    const res = await ask('  ADA@example.com ');
    expect(res.body).toEqual({});
    const mail = await mailTo('ada@example.com');
    expect(mail.subject).toBe('Your Focus Forest code');
    expect(mail.text).toMatch(/15 minutes/);

    const signedIn = await confirm(codeIn(mail)).expect(200);
    expect(signedIn.body).toMatchObject({ user: { email: 'ada@example.com' } });
    expect(typeof (signedIn.body as { accessToken: string }).accessToken).toBe('string');

    await http()
      .post('/auth/sign-in')
      .send({ email: 'ada@example.com', password: NEW_PASSWORD })
      .expect(200);
    await http()
      .post('/auth/sign-in')
      .send({ email: 'ada@example.com', password: PASSWORD })
      .expect(401);
  });

  it('answers the same for an email with no account, and sends nothing', async () => {
    await signUp();
    const res = await ask('nobody@example.com');
    expect(res.body).toEqual({});
    await ask('ada@example.com');
    await mailTo('ada@example.com');
    expect(mailer.sent.map((m) => m.to)).toEqual(['ada@example.com']);
  });

  it('signs out every other device', async () => {
    const before = (await signUp()).body as { refreshToken: string };
    await ask();
    await confirm(codeIn(await mailTo('ada@example.com'))).expect(200);
    await http().post('/auth/refresh').send({ refreshToken: before.refreshToken }).expect(401);
  });

  it('works once', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    await confirm(code).expect(200);
    const again = await confirm(code, 'ada@example.com', 'yet another password').expect(400);
    expect(again.body).toMatchObject({ code: 'reset_code_invalid' });
  });

  it('expires after 15 minutes', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    clock.set(new Date(clock.now().getTime() + 15 * MINUTE + 1));
    await confirm(code).expect(400);
  });

  it('only the newest code works', async () => {
    await signUp();
    await ask();
    const first = codeIn(await mailTo('ada@example.com'));
    mailer.sent = [];
    await ask();
    const second = codeIn(await mailTo('ada@example.com'));
    if (first !== second) await confirm(first).expect(400);
    await confirm(second).expect(200);
  });

  it('stops after 5 wrong tries, even for the right code', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await confirm(wrong).expect(400);
    await confirm(code).expect(400);
  });

  it('a code belongs to its own account', async () => {
    await signUp('ada@example.com');
    await signUp('ben@example.com');
    await ask('ada@example.com');
    const code = codeIn(await mailTo('ada@example.com'));
    await confirm(code, 'ben@example.com').expect(400);
  });

  it('checks the new password like sign-up, and keeps the code on a refusal', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    const res = await confirm(code, 'ada@example.com', 'short').expect(400);
    expect(JSON.stringify(res.body)).toContain('Use at least 8 characters for your password.');
    await confirm(code).expect(200);
  });

  it('never stores the code itself', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    const rows = await prisma.passwordResetCode.findMany();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('tells an account that signs in with Google to use Google, with no code', async () => {
    await prisma.user.create({
      data: {
        email: 'gia@gmail.com',
        passwordHash: null,
        identities: { create: { provider: 'google', subject: 'google-gia' } },
      },
    });
    await ask('gia@gmail.com');
    const mail = await mailTo('gia@gmail.com');
    expect(mail.text).toMatch(/Continue with Google/);
    expect(mail.text).not.toMatch(/\b\d{6}\b/);
    expect(await prisma.passwordResetCode.count()).toBe(0);
  });

  it('refuses a suspended account the same way as a wrong code', async () => {
    await signUp();
    await ask();
    const code = codeIn(await mailTo('ada@example.com'));
    await prisma.user.update({
      where: { email: 'ada@example.com' },
      data: { status: 'suspended' },
    });
    await confirm(code).expect(403);
  });
});
