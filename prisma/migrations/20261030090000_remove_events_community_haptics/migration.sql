-- Owner decision 2026-10-22: Events and the Community Tree, and the haptics preference, are
-- removed from the product. Nothing earned through them is kept: event badges, cosmetics, and
-- species (source `event`), the Community Contributor badge, their ownership, event traits on
-- every tree (growing and archived), and event entries in archived snapshots and recaps go too.
-- Seasonal content stays, including its badges (category `event`, source `season`).

-- 1. Event and Community Tree tables, their triggers and functions, and their enums.
DROP TABLE "community_reward_grants";
DROP TABLE "community_contributions";
DROP TABLE "community_milestones";
DROP TABLE "community_trees";
DROP TABLE "event_milestone_grants";
DROP TABLE "event_participations";
DROP TABLE "event_milestones";
DROP TABLE "event_missions";
DROP TABLE "event_teams";
DROP TABLE "events";
DROP FUNCTION "community_trees_never_shrink"();
DROP FUNCTION "community_milestones_reached_once"();
DROP FUNCTION "community_contributions_append_only"();
DROP TYPE "community_stage";
DROP TYPE "event_mission_measure";

-- A session's event result (missions, milestones) has nothing left to describe.
ALTER TABLE "focus_sessions" DROP COLUMN "event_result";

-- The event notice and Community Tree jobs have no handler any more.
DELETE FROM "jobs" WHERE "kind" IN ('events.notices', 'community.reached');

-- 2. The haptics preference.
ALTER TABLE "user_preferences" DROP COLUMN "haptics";

-- 3. The event notification categories: their settings, their notifications, and the values.
DELETE FROM "notification_preferences" WHERE "category" IN ('event_start', 'event_ending_soon');
DELETE FROM "notification_outbox" WHERE "category" IN ('event_start', 'event_ending_soon');
ALTER TYPE "notification_category" RENAME TO "notification_category_old";
CREATE TYPE "notification_category" AS ENUM ('daily_goal_reminder', 'scheduled_focus_reminder', 'streak_reminder', 'friend_invite', 'focus_room_invite', 'challenge_update', 'badge_unlocked', 'monthly_recap_ready');
ALTER TABLE "notification_preferences" ALTER COLUMN "category" TYPE "notification_category" USING "category"::text::"notification_category";
ALTER TABLE "notification_outbox" ALTER COLUMN "category" TYPE "notification_category" USING "category"::text::"notification_category";
DROP TYPE "notification_category_old";

-- 4. Event-only content and everything earned from it. The ids are kept in a work table so the
-- snapshots below can drop exactly these badges.
CREATE TABLE "_removed_event_badges" ("id" TEXT PRIMARY KEY);
INSERT INTO "_removed_event_badges" ("id")
SELECT "id" FROM "badge_definitions" WHERE "source" = 'event'
UNION
SELECT "badge_id" FROM "achievement_definitions" WHERE "criterion" = 'community_contributions'
UNION
SELECT "id" FROM "badge_definitions" WHERE "id" = 'community-contributor';

-- Badges: unpinned from showcases (the rest close up, in order), unowned, then undefined.
DELETE FROM "badge_showcase" WHERE "badge_id" IN (SELECT "id" FROM "_removed_event_badges");
CREATE TABLE "_showcase_kept" AS
SELECT "user_id", "badge_id",
  ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "position")::int AS "position"
FROM "badge_showcase";
DELETE FROM "badge_showcase";
INSERT INTO "badge_showcase" ("user_id", "badge_id", "position")
SELECT "user_id", "badge_id", "position" FROM "_showcase_kept";
DROP TABLE "_showcase_kept";
DELETE FROM "user_badges" WHERE "badge_id" IN (SELECT "id" FROM "_removed_event_badges");
DELETE FROM "achievement_definitions"
WHERE "criterion" = 'community_contributions'
   OR "badge_id" IN (SELECT "id" FROM "_removed_event_badges");
DELETE FROM "badge_definitions" WHERE "id" IN (SELECT "id" FROM "_removed_event_badges");

-- Cosmetics: unequipped, unowned, then undefined.
DELETE FROM "user_equipment"
WHERE "cosmetic_id" IN (SELECT "id" FROM "cosmetic_definitions" WHERE "source" = 'event');
DELETE FROM "user_cosmetics"
WHERE "cosmetic_id" IN (SELECT "id" FROM "cosmetic_definitions" WHERE "source" = 'event');
DELETE FROM "cosmetic_definitions" WHERE "source" = 'event';

-- Species: nothing ever granted one, but none may stay defined either.
DELETE FROM "user_species"
WHERE "species_id" IN (SELECT "id" FROM "tree_species" WHERE "source" = 'event');
DELETE FROM "tree_species" WHERE "source" = 'event';

-- 5. Event traits and entries on trees and in recaps. Archived trees and recaps are immutable
-- snapshots: their triggers are lifted for these statements only.
DELETE FROM "monthly_tree_traits" WHERE "trait_id" LIKE 'event:%';

ALTER TABLE "monthly_trees" DISABLE TRIGGER "monthly_trees_archived_immutable";
UPDATE "monthly_trees"
SET "archive" = jsonb_set("archive", '{traits}', COALESCE((
  SELECT jsonb_agg("trait" ORDER BY "position")
  FROM jsonb_array_elements("archive"->'traits') WITH ORDINALITY AS "t"("trait", "position")
  WHERE "trait"->>'id' NOT LIKE 'event:%'
), '[]'::jsonb))
WHERE "archive" IS NOT NULL AND EXISTS (
  SELECT 1 FROM jsonb_array_elements("archive"->'traits') AS "t"("trait")
  WHERE "trait"->>'id' LIKE 'event:%'
);
ALTER TABLE "monthly_trees" ENABLE TRIGGER "monthly_trees_archived_immutable";

ALTER TABLE "monthly_recaps" DISABLE TRIGGER "monthly_recaps_immutable";
UPDATE "monthly_recaps"
SET "content" = jsonb_set("content" - 'events', '{badges}', COALESCE((
  SELECT jsonb_agg("badge" ORDER BY "position")
  FROM jsonb_array_elements("content"->'badges') WITH ORDINALITY AS "b"("badge", "position")
  WHERE "badge"->>'badgeId' NOT IN (SELECT "id" FROM "_removed_event_badges")
), '[]'::jsonb))
WHERE "content" ? 'events' OR EXISTS (
  SELECT 1 FROM jsonb_array_elements("content"->'badges') AS "b"("badge")
  WHERE "badge"->>'badgeId' IN (SELECT "id" FROM "_removed_event_badges")
);
ALTER TABLE "monthly_recaps" ENABLE TRIGGER "monthly_recaps_immutable";

DROP TABLE "_removed_event_badges";

-- 6. The `event` content source and the Community Contributor criterion, now unused.
DROP TRIGGER "tree_species_system_permanent" ON "tree_species";
DROP TRIGGER "cosmetic_definitions_system_permanent" ON "cosmetic_definitions";
ALTER TABLE "tree_species" DROP CONSTRAINT "tree_species_source_check";
ALTER TABLE "cosmetic_definitions" DROP CONSTRAINT "cosmetic_definitions_source_check";
ALTER TYPE "content_source" RENAME TO "content_source_old";
CREATE TYPE "content_source" AS ENUM ('system', 'achievement', 'season');
ALTER TABLE "badge_definitions" ALTER COLUMN "source" TYPE "content_source" USING "source"::text::"content_source";
ALTER TABLE "tree_species" ALTER COLUMN "source" TYPE "content_source" USING "source"::text::"content_source";
ALTER TABLE "cosmetic_definitions" ALTER COLUMN "source" TYPE "content_source" USING "source"::text::"content_source";
DROP TYPE "content_source_old";
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_source_check" CHECK (("source" = 'achievement') = ("achievement_id" IS NOT NULL) AND ("base_species_id" IS NULL OR "base_species_id" <> "id"));
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_source_check" CHECK (("source" = 'achievement') = ("achievement_id" IS NOT NULL));
CREATE TRIGGER "tree_species_system_permanent" BEFORE UPDATE OR DELETE ON "tree_species" FOR EACH ROW WHEN (OLD."source" = 'system') EXECUTE FUNCTION "system_species_permanent"();
CREATE TRIGGER "cosmetic_definitions_system_permanent" BEFORE UPDATE OR DELETE ON "cosmetic_definitions" FOR EACH ROW WHEN (OLD."source" = 'system') EXECUTE FUNCTION "system_cosmetic_permanent"();

ALTER TYPE "achievement_criterion" RENAME TO "achievement_criterion_old";
CREATE TYPE "achievement_criterion" AS ENUM ('counted_sessions', 'focused_minutes', 'longest_streak_days', 'focus_together_sessions', 'focus_together_with_friend', 'sessions_before_7', 'sessions_after_22', 'full_weekends');
ALTER TABLE "achievement_definitions" ALTER COLUMN "criterion" TYPE "achievement_criterion" USING "criterion"::text::"achievement_criterion";
DROP TYPE "achievement_criterion_old";

-- 7. A configuration version without the event "ending soon" hours, made active.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" - 'notifications.eventEndingSoonHours',
    'Events removed (owner decision 2026-10-22).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true AND "versions"."values" ? 'notifications.eventEndingSoonHours'
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
