import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { addDays } from '../../src/common/local-date.js';
import { AchievementsService } from '../../src/progression/achievements.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A4.2 query characterization: evaluating achievements reads one value per criterion, never one
 * per definition, and stays flat as history grows. Also pins the A4.2 migration to additive
 * changes (no rewrite of Core or A4.1 rows).
 */

const t = new ConsistencyHarness('2026-10-20T12:00:00.000Z', { countQueries: true });

const MIGRATIONS = 'prisma/migrations';
const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith('_achievements_showcase'));
const migrationSql = readFileSync(join(MIGRATIONS, dir ?? 'missing', 'migration.sql'), 'utf8');

describe('A4.2 achievement queries (HTTP + PostgreSQL)', () => {
  let service: AchievementsService;

  beforeAll(async () => {
    await t.start();
    service = t.app.get(AchievementsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-20T12:00:00.000Z');
    await t.activateConfig();
  });

  async function moreDefinitions(count: number) {
    for (let i = 0; i < count; i += 1) {
      const id = `extra-${i}`;
      await t.prisma.badgeDefinition.create({
        data: {
          id,
          category: i % 2 ? 'focus' : 'consistency',
          rarity: 'common',
          source: 'achievement',
          availability: 'permanent',
          status: 'active',
          name: id,
          description: 'For tests.',
          artworkId: id,
        },
      });
      await t.prisma.achievementDefinition.create({
        data: {
          id,
          badgeId: id,
          criterion: (['counted_sessions', 'focused_minutes', 'longest_streak_days'] as const)[
            i % 3
          ]!,
          target: 1_000_000,
        },
      });
    }
  }

  const days = (from: string, count: number): [string, number][] =>
    Array.from({ length: count }, (_, i) => [addDays(from, i), 30]);

  it('reads a bounded number of statements, whatever the number of definitions or days', async () => {
    const small = await t.signUp('small@example.com');
    await t.focus(small, days('2026-10-01', 2));
    const large = await t.signUp('large@example.com');
    await t.focus(large, days('2024-01-01', 600));
    // Settle what each already earned, so the measured evaluations grant nothing.
    await service.reconcile(small.userId);
    await service.reconcile(large.userId);

    const evaluate = (userId: string) => t.queries.during(() => service.reconcile(userId));
    const smallNine = await evaluate(small.userId);
    const largeNine = await evaluate(large.userId);
    await moreDefinitions(30);
    const smallMany = await evaluate(small.userId);
    const largeMany = await evaluate(large.userId);
    const get = (user: { auth: Record<string, string> }) =>
      t.queries.during(() => t.http().get('/me/achievements').set(user.auth).expect(200));
    const getSmall = await get(small);
    const getLarge = await get(large);

    console.info(
      [
        `A4.2 evaluation statements — 9 definitions: small ${smallNine}, large ${largeNine};`,
        `39 definitions: small ${smallMany}, large ${largeMany};`,
        `GET /me/achievements: small ${getSmall}, large ${getLarge}`,
      ].join(' '),
    );
    expect(largeNine).toBe(smallNine);
    expect(smallMany).toBe(smallNine);
    expect(largeMany).toBe(smallNine);
    expect(getLarge).toBe(getSmall);
    // A4.3 adds one statement each for rewards linked to owned badges (species, cosmetics).
    expect(smallNine).toBeLessThanOrEqual(10);
  }, 120_000);

  it('is additive: no update or delete of existing rows, Core tables only gain a column', () => {
    expect(migrationSql).not.toMatch(/\bUPDATE\s+"/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM/i);
    expect(migrationSql).toMatch(
      /ALTER TABLE "focus_sessions" ADD COLUMN "progression_result" JSONB/,
    );
    expect(migrationSql).toMatch(/CREATE TABLE "badge_showcase"/);
  });
});
