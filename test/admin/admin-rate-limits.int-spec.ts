import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { RateLimitService } from '../../src/safety/rate-limit.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * D7.1 (API part) Rate-limit refusals for staff (A7.2): per limit, over the last day, how many
 * requests were refused and from how many addresses, emails, or people. Counts only: buckets
 * are hashed, so nothing says who.
 */

const t = new ConsistencyHarness('2026-11-06T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });

async function admin(email: string, role: 'admin' | 'support' | 'moderator' | 'content') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

describe('rate-limit refusals for staff (D7.1)', () => {
  beforeAll(async () => {
    await t.start();
    t.app.get(RateLimitService).enabled = true;
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-06T12:00:00.000Z');
  });

  it('counts refusals per limit over the last day', async () => {
    // Staff sign in before the limits tighten (admin sign-in is not limited).
    const auth = await admin('ops@example.com', 'support');
    await t.activateConfig({ 'rateLimit.signIn': { limit: 2, windowSeconds: 900 } });
    const signIn = (email: string) =>
      t.http().post('/auth/sign-in').send({ email, password: 'wrong, wrong, wrong' });
    // Five tries for one email from one address: two answered, then the address is refused (the
    // email is not counted once the address already refuses).
    for (let i = 0; i < 5; i += 1) await signIn('ana@example.com');

    const res = await t.http().get('/admin/rate-limits').set(auth).expect(200);
    const body = res.body as { since: string; items: Record<string, unknown>[] };
    expect(body.since).toBe('2026-11-05T12:00:00.000Z');
    expect(body.items[0]).toEqual({ name: 'signIn', limit: 2, refused: 3, keys: 1 });
    expect(body.items.find((item) => item['name'] === 'reports')).toEqual({
      name: 'reports',
      limit: expect.any(Number) as number,
      refused: 0,
      keys: 0,
    });

    // A day later the old windows no longer count.
    await t.setNow('2026-11-07T12:30:00.000Z');
    const later = await t
      .http()
      .get('/admin/rate-limits')
      .set(await admin('two@example.com', 'admin'));
    expect((later.body as { items: { refused: number }[] }).items[0]!.refused).toBe(0);
  });

  it('is for admins and support', async () => {
    for (const role of ['moderator', 'content'] as const) {
      await t
        .http()
        .get('/admin/rate-limits')
        .set(await admin(`${role}@example.com`, role))
        .expect(403);
    }
  });
});
