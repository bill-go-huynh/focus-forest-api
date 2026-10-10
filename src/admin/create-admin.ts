import { randomUUID } from 'node:crypto';

import type { AdminRole } from '../generated/prisma/client.js';
import type { PasswordHasher } from '../identity/password-hasher.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ROLES: readonly AdminRole[] = ['admin', 'support', 'moderator'];

export interface NewAdmin {
  email: string;
  role: string;
  password: string;
}

/**
 * Creates an admin (the bootstrap path: there is no admin-creation endpoint). The email is
 * lowercased; the password needs 12+ characters; an existing email is refused.
 */
export async function createAdmin(
  prisma: PrismaService,
  passwords: PasswordHasher,
  input: NewAdmin,
): Promise<{ id: string; email: string; role: AdminRole }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const role = ROLES.find((candidate) => candidate === input.role);
  if (!role) throw new Error(`The role must be one of: ${ROLES.join(', ')}.`);
  if (input.password.length < 12) throw new Error('Use at least 12 characters for the password.');
  if (await prisma.adminUser.findUnique({ where: { email } })) {
    throw new Error('An admin with this email already exists.');
  }
  const admin = await prisma.adminUser.create({
    data: { id: randomUUID(), email, role, passwordHash: await passwords.hash(input.password) },
    select: { id: true, email: true, role: true },
  });
  return admin;
}
