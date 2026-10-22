import { DEV_ADMIN, seedDevAdmin } from '../../src/admin/dev-admin-seed.js';
import { NodeEnv } from '../../src/config/env.validation.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A ready admin for local testing (owner, 2026-10-22): admin@focusforest.test / admin123, made
 * when the API starts in development, never in test or production, and never changed once made.
 */

const t = new ConsistencyHarness('2026-10-22T05:00:00.000Z');
const hasher = new PasswordHasher({ cost: 2 ** 10 });

describe('the development admin', () => {
  beforeAll(async () => {
    await t.start();
  });
  afterAll(() => t.stop());
  beforeEach(() => t.reset());

  it('is made in development, and signs in to the admin with admin123', async () => {
    expect(await seedDevAdmin(t.prisma, hasher, NodeEnv.Development)).toBe('created');
    const res = await t
      .http()
      .post('/admin/auth/sign-in')
      .send({ email: 'admin@focusforest.test', password: 'admin123' })
      .expect(200);
    expect(res.body).toMatchObject({ admin: { email: DEV_ADMIN.email, role: 'admin' } });
  });

  it('is made once, and an existing one is left as it is', async () => {
    await seedDevAdmin(t.prisma, hasher, NodeEnv.Development);
    const before = await t.prisma.adminUser.findUniqueOrThrow({
      where: { email: DEV_ADMIN.email },
    });
    expect(await seedDevAdmin(t.prisma, hasher, NodeEnv.Development)).toBe('exists');
    const after = await t.prisma.adminUser.findUniqueOrThrow({ where: { email: DEV_ADMIN.email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await t.prisma.adminUser.count()).toBe(1);
  });

  it.each([NodeEnv.Production, NodeEnv.Test])('is never made in %s', async (env) => {
    expect(await seedDevAdmin(t.prisma, hasher, env)).toBe('skipped');
    expect(await t.prisma.adminUser.count()).toBe(0);
  });
});
