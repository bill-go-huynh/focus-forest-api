import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTestPrismaClient,
  migrateFreshTestDatabase,
  testDatabaseUrl,
} from './test-database.js';

/**
 * Owner decision 2026-10-22: Events, the Community Tree, and the haptics preference are removed,
 * and nothing earned through events is kept. The migration runs here on a test database that
 * holds event data from before it: afterwards no one owns an event badge or cosmetic, no tree
 * (growing or archived) carries an event trait, recaps hold no event entries, and the immutable
 * snapshots are immutable again. Seasonal content, which shares the `event` badge category,
 * stays.
 */

const MIGRATIONS = 'prisma/migrations';
const REMOVAL = '20261030090000_remove_events_community_haptics';
type Client = ReturnType<typeof createTestPrismaClient>;

/** Runs a SQL script against the test database with the Prisma CLI, as one command. */
function execute(sql: string): void {
  const url = testDatabaseUrl();
  const dir = mkdtempSync(join(tmpdir(), 'ff-migration-'));
  try {
    const file = join(dir, 'script.sql');
    writeFileSync(file, sql);
    execFileSync('node_modules/.bin/prisma', ['db', 'execute', '--file', file], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const migration = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/** Every migration before the removal, applied in order. */
function migrateToBeforeRemoval(): void {
  const before = readdirSync(MIGRATIONS)
    .filter((name) => !name.endsWith('.toml') && name < REMOVAL)
    .sort();
  execute(before.map(migration).join('\n;\n'));
}

const ANA = '00000000-0000-4000-8000-00000000a001';

/** Ana, as the product left her before the removal: in an event, with what she earned there. */
const EVENT_WORLD = `
    INSERT INTO users (id, email, password_hash, timezone, updated_at)
    VALUES ('${ANA}', 'ana@example.com', 'x', 'UTC', now());
    INSERT INTO user_preferences (user_id, theme, sound, haptics, reduced_motion, updated_at)
    VALUES ('${ANA}', 'system', true, true, false, now());
    INSERT INTO notification_preferences (user_id, category, enabled, updated_at) VALUES
      ('${ANA}', 'event_start', true, now()),
      ('${ANA}', 'event_ending_soon', true, now()),
      ('${ANA}', 'friend_invite', true, now());
    INSERT INTO notification_outbox
      (user_id, category, dedupe_key, title, body, link, requested, not_before, expires_at,
       created_at, status, sent_at)
    VALUES
      ('${ANA}', 'event_start', 'event-start:autumn', 'Autumn has begun', 'Join.',
       '/together/events/autumn', false, now(), now() + interval '1 day', now(), 'sent', now()),
      ('${ANA}', 'badge_unlocked', 'badge:first', 'A new badge: First', 'In your collection.',
       '/profile/achievements', false, now(), now() + interval '1 day', now(), 'sent', now());
    INSERT INTO jobs (kind, payload, run_at, dedupe_key) VALUES
      ('events.notices', '{}', now(), 'events.notices:1'),
      ('community.reached', '{}', now(), 'community.reached:1');

    INSERT INTO badge_definitions
      (id, category, rarity, source, availability, status, name, description, artwork_id)
    VALUES
      ('autumn:steady', 'event', 'common', 'event', 'permanent', 'active', 'Steady',
       'An event badge.', 'autumn-steady'),
      ('autumn:oak', 'event', 'common', 'event', 'permanent', 'active', 'Oak',
       'A Community Tree badge.', 'autumn-oak'),
      ('season:autumn', 'event', 'common', 'season', 'permanent', 'active', 'Autumn',
       'A seasonal badge.', 'season-autumn');
    INSERT INTO cosmetic_definitions
      (id, type, rarity, source, availability, status, name, description, artwork_id)
    VALUES
      ('lanterns', 'decoration', 'rare', 'event', 'permanent', 'active', 'Lanterns',
       'An event cosmetic.', 'lanterns'),
      ('leaves', 'weather', 'common', 'season', 'permanent', 'active', 'Leaves',
       'A seasonal cosmetic.', 'leaves');
    INSERT INTO tree_species
      (id, rarity, source, availability, status, name, description)
    VALUES ('event-pine', 'rare', 'event', 'permanent', 'active', 'Event Pine', 'Never granted.');

    INSERT INTO events (id, name, description, artwork_id, status, starts_at, ends_at, leaderboard)
    VALUES ('autumn', 'Autumn', 'An event.', 'autumn', 'active', '2026-09-01', '2026-10-31', true);
    INSERT INTO event_teams (event_id, id, name) VALUES ('autumn', 'oak', 'Oak');
    INSERT INTO event_missions (event_id, id, measure, target, name, description)
    VALUES ('autumn', 'hour', 'focus_minutes', 60, 'An hour', 'One hour.');
    INSERT INTO event_milestones
      (event_id, id, required_missions, badge_id, cosmetic_id, trait_id, name)
    VALUES ('autumn', 'steady', 1, 'autumn:steady', 'lanterns', 'event:autumn', 'Steady');
    INSERT INTO event_participations (user_id, event_id, joined_at, team_id)
    VALUES ('${ANA}', 'autumn', '2026-09-02', 'oak');
    INSERT INTO event_milestone_grants (user_id, event_id, milestone_id, reached_at)
    VALUES ('${ANA}', 'autumn', 'steady', '2026-09-10');
    INSERT INTO community_trees (event_id, name, artwork_id, total_minutes)
    VALUES ('autumn', 'Oak', 'oak', 60);
    INSERT INTO community_milestones (event_id, stage, threshold_minutes, badge_id, reached_at)
    VALUES ('autumn', 'seedling', 30, 'autumn:oak', '2026-09-10');
    INSERT INTO community_contributions (event_id, user_id, session_id, minutes, contributed_at)
    VALUES ('autumn', '${ANA}', '00000000-0000-4000-8000-00000000c001', 60, '2026-09-10');
    INSERT INTO community_reward_grants (user_id, event_id, stage, granted_at)
    VALUES ('${ANA}', 'autumn', 'seedling', '2026-09-10');

    INSERT INTO user_badges (user_id, badge_id, earned_at) VALUES
      ('${ANA}', 'autumn:steady', '2026-09-10'),
      ('${ANA}', 'autumn:oak', '2026-09-10'),
      ('${ANA}', 'community-contributor', '2026-09-10'),
      ('${ANA}', 'first-session', '2026-09-03'),
      ('${ANA}', 'season:autumn', '2026-09-20');
    INSERT INTO badge_showcase (user_id, badge_id, position) VALUES
      ('${ANA}', 'autumn:steady', 1),
      ('${ANA}', 'season:autumn', 2),
      ('${ANA}', 'first-session', 3);
    INSERT INTO user_cosmetics (user_id, cosmetic_id, unlocked_at) VALUES
      ('${ANA}', 'lanterns', '2026-09-10'),
      ('${ANA}', 'leaves', '2026-09-20');
    INSERT INTO user_equipment (user_id, slot, cosmetic_id) VALUES
      ('${ANA}', 'decoration', 'lanterns'),
      ('${ANA}', 'weather', 'leaves');
    INSERT INTO user_species (user_id, species_id, unlocked_at)
    VALUES ('${ANA}', 'event-pine', '2026-09-10');

    INSERT INTO month_attribution_contexts (user_id, year, month, timezone, starts_at, ends_at)
    VALUES
      ('${ANA}', 2026, 9, 'UTC', '2026-09-01', '2026-10-01'),
      ('${ANA}', 2026, 10, 'UTC', '2026-10-01', '2026-11-01');
    INSERT INTO monthly_trees
      (user_id, year, month, species, variation_seed, config_version, joined_on,
       proration_numerator, proration_denominator, updated_at)
    SELECT '${ANA}', 2026, m, 'signature', 7, version, '2026-09-01', 1, 1, now()
    FROM active_product_config, (VALUES (9), (10)) AS months(m);
    INSERT INTO monthly_tree_traits (user_id, year, month, trait_id, earned_at) VALUES
      ('${ANA}', 2026, 9, 'monthly-focus-hours:10', '2026-09-08'),
      ('${ANA}', 2026, 9, 'event:autumn', '2026-09-10'),
      ('${ANA}', 2026, 10, 'event:autumn', '2026-10-02'),
      ('${ANA}', 2026, 10, 'streak-days:3', '2026-10-03');
    UPDATE monthly_trees SET status = 'archived', archived_at = '2026-10-01', archive = '{
      "timezone": "UTC",
      "progress": {},
      "traits": [
        {"id": "monthly-focus-hours:10", "earnedAt": "2026-09-08T00:00:00.000Z"},
        {"id": "event:autumn", "earnedAt": "2026-09-10T00:00:00.000Z"}
      ],
      "stats": {}
    }'
    WHERE user_id = '${ANA}' AND month = 9;
    INSERT INTO monthly_recaps (user_id, year, month, content, created_at)
    VALUES ('${ANA}', 2026, 9, '{
      "stats": {},
      "mostProductiveDay": null,
      "mostProductiveWeek": null,
      "newRecords": [],
      "highlightedNotes": [],
      "badges": [
        {"badgeId": "first-session", "earnedAt": "2026-09-03T00:00:00.000Z"},
        {"badgeId": "autumn:steady", "earnedAt": "2026-09-10T00:00:00.000Z"},
        {"badgeId": "community-contributor", "earnedAt": "2026-09-10T00:00:00.000Z"},
        {"badgeId": "season:autumn", "earnedAt": "2026-09-20T00:00:00.000Z"}
      ],
      "events": []
    }', '2026-10-01');
`;

describe('removing events, the Community Tree, and the haptics preference (2026-10-22)', () => {
  let prisma: Client;

  beforeAll(() => {
    prisma = createTestPrismaClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    // Every other test runs on a database migrated the usual way.
    await migrateFreshTestDatabase();
  });

  const rows = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);

  it('removes everything earned through events and keeps seasonal content', async () => {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
    migrateToBeforeRemoval();
    execute(EVENT_WORLD);
    const configBefore = await rows<{ version: number; values: Record<string, unknown> }>(
      `SELECT v.version, v.values FROM active_product_config a
       JOIN product_config_versions v ON v.version = a.version`,
    );
    expect(configBefore[0]!.values).toHaveProperty('notifications.eventEndingSoonHours');

    execute(migration(REMOVAL));

    // Event and Community Tree tables, enums, and functions are gone.
    const tables = await rows<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
       AND (tablename LIKE 'event%' OR tablename LIKE 'community%' OR tablename LIKE '\\_%')
       AND tablename <> '_prisma_migrations'`,
    );
    expect(tables).toEqual([]);
    const types = await rows<{ name: string }>(
      `SELECT typname AS name FROM pg_type
       WHERE typname IN ('community_stage', 'event_mission_measure')
          OR typname LIKE '%\\_old'`,
    );
    expect(types).toEqual([]);
    const functions = await rows<{ name: string }>(
      `SELECT proname AS name FROM pg_proc WHERE proname LIKE 'community%'`,
    );
    expect(functions).toEqual([]);
    const columns = await rows<{ name: string }>(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('haptics', 'event_result')`,
    );
    expect(columns).toEqual([]);
    const values = async (type: string) =>
      (
        await rows<{ value: string }>(`SELECT unnest(enum_range(NULL::${type}))::text AS value`)
      ).map((row) => row.value);
    expect(await values('notification_category')).not.toEqual(
      expect.arrayContaining(['event_start']),
    );
    expect(await values('notification_category')).not.toContain('event_ending_soon');
    expect(await values('content_source')).toEqual(['system', 'achievement', 'season']);
    expect(await values('achievement_criterion')).not.toContain('community_contributions');
    // Seasonal badges keep the `event` category.
    expect(await values('badge_category')).toContain('event');

    // No one owns an event badge, cosmetic, or species; seasonal ones stay owned.
    expect(
      await rows<{ id: string }>(
        `SELECT badge_id AS id FROM user_badges WHERE user_id = '${ANA}' ORDER BY badge_id`,
      ),
    ).toEqual([{ id: 'first-session' }, { id: 'season:autumn' }]);
    expect(
      await rows<{ id: string }>(
        `SELECT id FROM badge_definitions
         WHERE id IN ('autumn:steady', 'autumn:oak', 'community-contributor', 'season:autumn')`,
      ),
    ).toEqual([{ id: 'season:autumn' }]);
    expect(
      await rows<{ id: string }>(
        `SELECT id FROM achievement_definitions WHERE badge_id = 'community-contributor'`,
      ),
    ).toEqual([]);
    expect(
      await rows<{ id: string; position: number }>(
        `SELECT badge_id AS id, position FROM badge_showcase ORDER BY position`,
      ),
    ).toEqual([
      { id: 'season:autumn', position: 1 },
      { id: 'first-session', position: 2 },
    ]);
    expect(await rows<{ id: string }>(`SELECT cosmetic_id AS id FROM user_cosmetics`)).toEqual([
      { id: 'leaves' },
    ]);
    expect(await rows<{ id: string }>(`SELECT cosmetic_id AS id FROM user_equipment`)).toEqual([
      { id: 'leaves' },
    ]);
    expect(
      await rows<{ id: string }>(`SELECT id FROM cosmetic_definitions WHERE id = 'lanterns'`),
    ).toEqual([]);
    expect(await rows<{ id: string }>(`SELECT species_id AS id FROM user_species`)).toEqual([]);
    expect(
      await rows<{ id: string }>(`SELECT id FROM tree_species WHERE id = 'event-pine'`),
    ).toEqual([]);

    // No tree, growing or archived, carries an event trait.
    expect(
      await rows<{ month: number; id: string }>(
        `SELECT month, trait_id AS id FROM monthly_tree_traits ORDER BY month, trait_id`,
      ),
    ).toEqual([
      { month: 9, id: 'monthly-focus-hours:10' },
      { month: 10, id: 'streak-days:3' },
    ]);
    const [archived] = await rows<{ archive: { traits: { id: string }[] } }>(
      `SELECT archive FROM monthly_trees WHERE month = 9`,
    );
    expect(archived!.archive.traits).toEqual([
      { id: 'monthly-focus-hours:10', earnedAt: '2026-09-08T00:00:00.000Z' },
    ]);

    // Recaps hold no event entries and no removed badge.
    const [recap] = await rows<{ content: Record<string, unknown> }>(
      `SELECT content FROM monthly_recaps`,
    );
    expect(recap!.content).not.toHaveProperty('events');
    expect(recap!.content['badges']).toEqual([
      { badgeId: 'first-session', earnedAt: '2026-09-03T00:00:00.000Z' },
      { badgeId: 'season:autumn', earnedAt: '2026-09-20T00:00:00.000Z' },
    ]);

    // Archived trees and recaps are immutable again.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE monthly_trees SET species = 'oak' WHERE month = 9`),
    ).rejects.toThrow(/archived monthly tree/);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE monthly_recaps SET content = '{}'`),
    ).rejects.toThrow(/monthly recap/);
    // And a system cosmetic is still permanent (its trigger was rebuilt with the enum).
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM cosmetic_definitions WHERE source = 'system'`),
    ).rejects.toThrow(/system cosmetic/);

    // The event notices and jobs are gone; other notifications stay.
    expect(
      await rows<{ category: string }>(
        `SELECT category::text FROM notification_preferences ORDER BY category`,
      ),
    ).toEqual([{ category: 'friend_invite' }]);
    expect(
      await rows<{ category: string }>(`SELECT category::text FROM notification_outbox`),
    ).toEqual([{ category: 'badge_unlocked' }]);
    expect(await rows<{ kind: string }>(`SELECT kind FROM jobs`)).toEqual([]);

    // The active configuration no longer holds the event "ending soon" hours, and only that.
    const [config] = await rows<{ version: number; values: Record<string, unknown> }>(
      `SELECT v.version, v.values FROM active_product_config a
       JOIN product_config_versions v ON v.version = a.version`,
    );
    expect(config!.version).toBe(configBefore[0]!.version + 1);
    const { ['notifications.eventEndingSoonHours']: removed, ...kept } = configBefore[0]!.values;
    expect(removed).toBe(48);
    expect(config!.values).toEqual(kept);
  });
});
