import { readdirSync, readFileSync } from 'node:fs';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A4.4 query characterization: GET /me/collection sends the same number of statements for the
 * current catalog and with 100+ more definitions, and answers every visible item. A4.4 adds no
 * migration: the Collection Book is derived.
 */

const t = new ConsistencyHarness('2026-10-07T20:00:00.000Z', { countQueries: true });

interface CollectionBody {
  sections: { kind: string; owned: number; total: number; items: { id: string }[] }[];
}

describe('A4.4 collection queries (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-07T20:00:00.000Z');
    await t.activateConfig();
  });

  async function moreDefinitions(count: number) {
    for (let i = 0; i < count; i += 1) {
      const id = `extra-${i}`;
      await t.prisma.badgeDefinition.create({
        data: {
          id,
          category: 'focus',
          rarity: 'common',
          source: 'achievement',
          availability: 'permanent',
          status: 'active',
          name: id,
          description: 'For tests.',
          artworkId: id,
          sortOrder: 1000 + i,
        },
      });
      await t.prisma.achievementDefinition.create({
        data: { id, badgeId: id, criterion: 'focused_minutes', target: 1_000_000 },
      });
      await t.prisma.treeSpecies.create({
        data: {
          id: `${id}-tree`,
          rarity: 'common',
          source: 'achievement',
          achievementId: id,
          availability: 'permanent',
          status: 'active',
          name: `${id} tree`,
          description: 'For tests.',
          sortOrder: 1000 + i,
        },
      });
      await t.prisma.cosmeticDefinition.create({
        data: {
          id: `${id}-stone`,
          type: 'decoration',
          rarity: 'common',
          source: i % 2 ? 'system' : 'achievement',
          achievementId: i % 2 ? null : id,
          availability: 'permanent',
          status: 'active',
          name: `${id} stone`,
          description: 'For tests.',
          artworkId: `${id}-stone`,
          sortOrder: 1000 + i,
        },
      });
    }
  }

  it('reads a bounded number of statements whatever the catalog size, and answers it all', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.submit(ada, '2026-10-07T18:00:00.000Z', 25).expect(201);
    const read = async () => {
      let body: CollectionBody | undefined;
      const statements = await t.queries.during(async () => {
        body = (await t.http().get('/me/collection').set(ada.auth).expect(200))
          .body as CollectionBody;
      });
      return { statements, body: body! };
    };
    await read();
    const small = await read();
    await moreDefinitions(100);
    await read();
    const large = await read();
    console.info(
      `A4.4 GET /me/collection statements — current catalog ${small.statements}; +300 definitions ${large.statements}`,
    );
    expect(large.statements).toBe(small.statements);
    expect(large.body.sections.map((s) => [s.kind, s.total])).toEqual([
      ['species', 109],
      ['badges', 109],
      ['cosmetics', 105],
    ]);
    expect((await read()).body).toEqual(large.body);
  }, 120_000);

  it('adds no migration: the Collection Book is derived', () => {
    // No migration (A4.4's or any later one) stores the Collection Book: no table, no column.
    const migrations = readdirSync('prisma/migrations').filter((name) => !name.endsWith('.toml'));
    expect(migrations.some((name) => /collection/.test(name))).toBe(false);
    const sql = migrations
      .map((name) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'))
      .join('\n');
    expect(sql).not.toMatch(/CREATE TABLE "[a-z_]*collection[a-z_]*"/i);
    expect(sql).not.toMatch(/ADD COLUMN\s+"[a-z_]*collection[a-z_]*"/i);
  });
});
