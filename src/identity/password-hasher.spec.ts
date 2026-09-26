import { PasswordHasher } from './password-hasher.js';

// A low cost keeps tests fast. Production uses the default cost.
const hasher = new PasswordHasher({ cost: 2 ** 10 });

describe('PasswordHasher', () => {
  it('never stores the password itself', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(hasher.verify('correct horse battery stapler', hash)).resolves.toBe(false);
  });

  it('uses a new salt for every hash', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')]);
    expect(a).not.toBe(b);
  });

  it('verifies with the parameters stored in the hash, so the cost can change later', async () => {
    const old = await new PasswordHasher({ cost: 2 ** 11 }).hash('same password');
    await expect(hasher.verify('same password', old)).resolves.toBe(true);
  });

  it.each(['', 'plain-text', 'scrypt$1$2$3', 'bcrypt$2b$10$abc'])(
    'rejects a malformed stored hash (%s) instead of throwing',
    async (stored) => {
      await expect(hasher.verify('anything', stored)).resolves.toBe(false);
    },
  );

  it('uses a strong cost by default', () => {
    expect(new PasswordHasher().cost).toBeGreaterThanOrEqual(2 ** 17);
  });
});
