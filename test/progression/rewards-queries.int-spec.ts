import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A4.3 query characterization: the species, cosmetics, and equipment reads send the same number
 * of statements whatever the size of the catalog or of the user's collection; and the A4.3
 * migration only adds (no rewrite of trees, recaps, or earlier ownership).
 */

const t = new ConsistencyHarness('2026-10-07T20:00:00.000Z', { countQueries: true });

const MIGRATIONS = 'prisma/migrations';
const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith('_species_cosmetics_equipment'));
const migrationSql = readFileSync(join(MIGRATIONS, dir ?? 'missing', 'migration.sql'), 'utf8');

describe('A4.3 reward queries (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-07T20:00:00.000Z');
    await t.activateConfig();
  });

  async function moreContent(count: number, userAuth: Record<string, string>) {
    for (let i = 0; i < count; i += 1) {
      await t.prisma.cosmeticDefinition.create({
        data: {
          id: `extra-${i}`,
          type: 'decoration',
          rarity: 'common',
          source: i % 2 ? 'system' : 'achievement',
          achievementId: i % 2 ? null : 'first-session',
          availability: 'permanent',
          status: 'active',
          name: `Extra ${i}`,
          description: 'For tests.',
          artworkId: `extra-${i}`,
          sortOrder: 100 + i,
        },
      });
      await t.prisma.treeSpecies.create({
        data: {
          id: `extra-tree-${i}`,
          rarity: 'common',
          source: 'achievement',
          achievementId: 'first-session',
          availability: 'permanent',
          status: 'active',
          name: `Extra tree ${i}`,
          description: 'For tests.',
          sortOrder: 100 + i,
        },
      });
    }
    // Settle the new rewards, so the measured reads grant nothing.
    await t.http().get('/me/badges').set(userAuth).expect(200);
  }

  it('reads a bounded number of statements, whatever the catalog or collection size', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.submit(ada, '2026-10-07T18:00:00.000Z', 25).expect(201);
    await t
      .http()
      .put('/me/equipment/decoration')
      .set(ada.auth)
      .send({ cosmeticId: 'mossy-stones' })
      .expect(200);
    const measure = async () => {
      const out: Record<string, number> = {};
      for (const path of ['/me/species', '/me/cosmetics', '/me/equipment']) {
        out[path] = await t.queries.during(() => t.http().get(path).set(ada.auth).expect(200));
      }
      return out;
    };
    await measure();
    const small = await measure();
    await moreContent(30, ada.auth);
    await measure();
    const large = await measure();
    console.info(
      `A4.3 statements — small catalog ${JSON.stringify(small)}; +60 items ${JSON.stringify(large)}`,
    );
    expect(large).toEqual(small);
    expect(await t.prisma.userCosmetic.count({ where: { userId: ada.userId } })).toBe(15);
  }, 120_000);

  it('is additive: no update or delete of existing rows', () => {
    expect(migrationSql).not.toMatch(/\bUPDATE\s+"/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM/i);
    expect(migrationSql).not.toMatch(
      /ALTER TABLE "(monthly_trees|monthly_recaps|focus_sessions|user_badges|user_species|user_cosmetics)"/,
    );
    expect(migrationSql).toMatch(/CREATE TABLE "user_equipment"/);
  });
});
