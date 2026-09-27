import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestPrismaClient } from '../database/test-database.js';

// The topics migration relies on the built-in "pg_c_utf8" collation (PostgreSQL 17+), so the
// active-name rule does not depend on the database locale or on an ICU build. Prisma does not
// run a migration in a transaction, so a missing requirement must fail before any DDL runs.
const MIGRATIONS = 'prisma/migrations';
const directory = readdirSync(MIGRATIONS).find((name) => name.endsWith('_topics'));
const sql = readFileSync(join(MIGRATIONS, directory ?? 'missing', 'migration.sql'), 'utf8');
const guard = /^DO \$\$[\s\S]*?^END \$\$;$/m.exec(sql)?.[0];

describe('topics migration', () => {
  const prisma = createTestPrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('checks its database requirement before creating anything', () => {
    expect(guard).toBeDefined();
    const firstDdl = sql.search(/^(CREATE|ALTER)\b/m);
    expect(sql.indexOf(guard ?? '')).toBeLessThan(firstDdl);
  });

  it('passes the check on the supported database', async () => {
    await expect(prisma.$executeRawUnsafe(guard ?? '')).resolves.toBeDefined();
  });

  it('fails with a clear message when the collation is missing', async () => {
    const withoutCollation = (guard ?? '').replaceAll("'pg_c_utf8'", "'missing_c_utf8'");
    await expect(prisma.$executeRawUnsafe(withoutCollation)).rejects.toThrow(
      /PostgreSQL 17 or later/,
    );
  });

  it('compares active names with the built-in collation, not ICU or the database locale', async () => {
    const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'topics_user_id_active_name_key'`;
    expect(index?.indexdef).toContain('lower((name COLLATE pg_c_utf8))');
    expect(index?.indexdef).toContain("WHERE (status = 'active'::topic_status)");
    expect(sql).not.toContain('und-x-icu');
  });
});
