-- Phase 4 / legacy 8–10, A4.1: the progression foundation (docs/06_DOMAIN_MODEL.md →
-- Progression entities). Content definitions (badges, achievements, species, cosmetics) are
-- versioned seed data here until the admin product (Phase 19); ownership is permanent user
-- state. Nothing here changes focus, growth, goals, streaks, or recovery. No existing row of
-- monthly_trees, monthly_recaps, monthly_tree_traits, or focus_sessions is changed: the
-- signature species they already name is defined, then referenced by a constraint.

-- CreateEnum
CREATE TYPE "content_status" AS ENUM ('planned', 'active', 'retired');

-- CreateEnum
CREATE TYPE "content_source" AS ENUM ('system', 'achievement', 'event', 'season');

-- CreateEnum
CREATE TYPE "content_availability" AS ENUM ('permanent', 'limited');

-- CreateEnum
CREATE TYPE "content_rarity" AS ENUM ('common', 'rare', 'legendary');

-- CreateEnum
CREATE TYPE "badge_category" AS ENUM ('focus', 'consistency', 'time_based', 'social', 'event', 'rare');

-- CreateEnum
CREATE TYPE "cosmetic_type" AS ENUM ('background', 'decoration', 'fauna', 'weather', 'profile_frame', 'effect');

-- CreateEnum
CREATE TYPE "achievement_criterion" AS ENUM ('counted_sessions', 'focused_minutes', 'longest_streak_days');

-- CreateTable
CREATE TABLE "badge_definitions" (
    "id" TEXT NOT NULL,
    "category" "badge_category" NOT NULL,
    "rarity" "content_rarity" NOT NULL,
    "source" "content_source" NOT NULL,
    "availability" "content_availability" NOT NULL,
    "status" "content_status" NOT NULL,
    "available_from" TIMESTAMP(3),
    "available_until" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "artwork_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievement_definitions" (
    "id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "criterion" "achievement_criterion" NOT NULL,
    "target" INTEGER NOT NULL,
    "progress_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievement_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tree_species" (
    "id" TEXT NOT NULL,
    "base_species_id" TEXT,
    "rarity" "content_rarity" NOT NULL,
    "source" "content_source" NOT NULL,
    "achievement_id" TEXT,
    "availability" "content_availability" NOT NULL,
    "status" "content_status" NOT NULL,
    "available_from" TIMESTAMP(3),
    "available_until" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tree_species_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cosmetic_definitions" (
    "id" TEXT NOT NULL,
    "type" "cosmetic_type" NOT NULL,
    "rarity" "content_rarity" NOT NULL,
    "source" "content_source" NOT NULL,
    "achievement_id" TEXT,
    "availability" "content_availability" NOT NULL,
    "status" "content_status" NOT NULL,
    "available_from" TIMESTAMP(3),
    "available_until" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "artwork_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cosmetic_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "user_id" UUID NOT NULL,
    "badge_id" TEXT NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("user_id","badge_id")
);

-- CreateTable
CREATE TABLE "user_species" (
    "user_id" UUID NOT NULL,
    "species_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_species_pkey" PRIMARY KEY ("user_id","species_id")
);

-- CreateTable
CREATE TABLE "user_cosmetics" (
    "user_id" UUID NOT NULL,
    "cosmetic_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_cosmetics_pkey" PRIMARY KEY ("user_id","cosmetic_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "achievement_definitions_badge_id_key" ON "achievement_definitions"("badge_id");

-- AddForeignKey
ALTER TABLE "achievement_definitions" ADD CONSTRAINT "achievement_definitions_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_base_species_id_fkey" FOREIGN KEY ("base_species_id") REFERENCES "tree_species"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievement_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_species" ADD CONSTRAINT "user_species_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_species" ADD CONSTRAINT "user_species_species_id_fkey" FOREIGN KEY ("species_id") REFERENCES "tree_species"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_cosmetic_id_fkey" FOREIGN KEY ("cosmetic_id") REFERENCES "cosmetic_definitions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identifiers: immutable lowercase slugs with an optional parameter (src/progression/progression-rules.ts).
ALTER TABLE "badge_definitions" ADD CONSTRAINT "badge_definitions_id_check" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$');
ALTER TABLE "achievement_definitions" ADD CONSTRAINT "achievement_definitions_id_check" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$');
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_id_check" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$');
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_id_check" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$');

-- Permanent content has no end; limited content ends; a window never ends before it starts.
ALTER TABLE "badge_definitions" ADD CONSTRAINT "badge_definitions_window_check" CHECK ((("availability" = 'permanent' AND "available_until" IS NULL) OR ("availability" = 'limited' AND "available_until" IS NOT NULL)) AND ("available_from" IS NULL OR "available_until" IS NULL OR "available_from" < "available_until"));
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_window_check" CHECK ((("availability" = 'permanent' AND "available_until" IS NULL) OR ("availability" = 'limited' AND "available_until" IS NOT NULL)) AND ("available_from" IS NULL OR "available_until" IS NULL OR "available_from" < "available_until"));
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_window_check" CHECK ((("availability" = 'permanent' AND "available_until" IS NULL) OR ("availability" = 'limited' AND "available_until" IS NOT NULL)) AND ("available_from" IS NULL OR "available_until" IS NULL OR "available_from" < "available_until"));

-- Copy is never blank.
ALTER TABLE "badge_definitions" ADD CONSTRAINT "badge_definitions_copy_check" CHECK (btrim("name") <> '' AND btrim("description") <> '' AND btrim("artwork_id") <> '');
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_copy_check" CHECK (btrim("name") <> '' AND btrim("description") <> '');
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_copy_check" CHECK (btrim("name") <> '' AND btrim("description") <> '' AND btrim("artwork_id") <> '');

-- An achievement measures something real.
ALTER TABLE "achievement_definitions" ADD CONSTRAINT "achievement_definitions_target_check" CHECK ("target" > 0);

-- An achievement source names its achievement; no other source does. A variant is not its own base.
ALTER TABLE "tree_species" ADD CONSTRAINT "tree_species_source_check" CHECK (("source" = 'achievement') = ("achievement_id" IS NOT NULL) AND ("base_species_id" IS NULL OR "base_species_id" <> "id"));
ALTER TABLE "cosmetic_definitions" ADD CONSTRAINT "cosmetic_definitions_source_check" CHECK (("source" = 'achievement') = ("achievement_id" IS NOT NULL));

-- A shipped identifier is never renamed (owners and archived trees store it).
CREATE FUNCTION "content_id_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'a content identifier cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "badge_definitions_id_immutable" BEFORE UPDATE ON "badge_definitions" FOR EACH ROW EXECUTE FUNCTION "content_id_immutable"();
CREATE TRIGGER "achievement_definitions_id_immutable" BEFORE UPDATE ON "achievement_definitions" FOR EACH ROW EXECUTE FUNCTION "content_id_immutable"();
CREATE TRIGGER "tree_species_id_immutable" BEFORE UPDATE ON "tree_species" FOR EACH ROW EXECUTE FUNCTION "content_id_immutable"();
CREATE TRIGGER "cosmetic_definitions_id_immutable" BEFORE UPDATE ON "cosmetic_definitions" FOR EACH ROW EXECUTE FUNCTION "content_id_immutable"();

-- A system species is owned by every user, so it stays active, system, and defined forever.
CREATE FUNCTION "system_species_permanent"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."source" <> 'system' OR NEW."status" <> 'active' THEN
    RAISE EXCEPTION 'a system species is owned by everyone and cannot be retired or removed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "tree_species_system_permanent" BEFORE UPDATE OR DELETE ON "tree_species" FOR EACH ROW WHEN (OLD."source" = 'system') EXECUTE FUNCTION "system_species_permanent"();

-- Ownership is permanent: it is never changed (deleting the user still removes it).
CREATE FUNCTION "ownership_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ownership cannot change';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "user_badges_immutable" BEFORE UPDATE ON "user_badges" FOR EACH ROW EXECUTE FUNCTION "ownership_immutable"();
CREATE TRIGGER "user_species_immutable" BEFORE UPDATE ON "user_species" FOR EACH ROW EXECUTE FUNCTION "ownership_immutable"();
CREATE TRIGGER "user_cosmetics_immutable" BEFORE UPDATE ON "user_cosmetics" FOR EACH ROW EXECUTE FUNCTION "ownership_immutable"();

-- Content seed: the initial catalog (A4.1). Achievements only where Phase 3 truth already defines the
-- measure; time-based, event, and rare content waits for its criteria. Social badges are defined
-- now and become earnable in Phase 11.
INSERT INTO "tree_species" ("id", "rarity", "source", "availability", "status", "name", "description", "sort_order") VALUES
  ('signature', 'common', 'system', 'permanent', 'active', 'Signature Tree', 'The broad-leaf tree every forest begins with.', 10);

INSERT INTO "badge_definitions" ("id", "category", "rarity", "source", "availability", "status", "name", "description", "artwork_id", "sort_order") VALUES
  ('first-session', 'focus', 'common', 'achievement', 'permanent', 'active', 'First Session', 'Your first counted focus session.', 'first-session', 10),
  ('focus-hours:10', 'focus', 'common', 'achievement', 'permanent', 'active', '10 Hours', '10 hours of counted focus.', 'focus-hours-10', 20),
  ('focus-hours:50', 'focus', 'common', 'achievement', 'permanent', 'active', '50 Hours', '50 hours of counted focus.', 'focus-hours-50', 30),
  ('focus-hours:100', 'focus', 'rare', 'achievement', 'permanent', 'active', '100 Hours', '100 hours of counted focus.', 'focus-hours-100', 40),
  ('focus-hours:500', 'focus', 'legendary', 'achievement', 'permanent', 'active', '500 Hours', '500 hours of counted focus.', 'focus-hours-500', 50),
  ('focus-streak:3', 'consistency', 'common', 'achievement', 'permanent', 'active', '3-Day Streak', 'Focused 3 days in a row.', 'focus-streak-3', 60),
  ('focus-streak:7', 'consistency', 'common', 'achievement', 'permanent', 'active', '7-Day Streak', 'Focused 7 days in a row.', 'focus-streak-7', 70),
  ('focus-streak:30', 'consistency', 'rare', 'achievement', 'permanent', 'active', '30-Day Streak', 'Focused 30 days in a row.', 'focus-streak-30', 80),
  ('focus-streak:100', 'consistency', 'legendary', 'achievement', 'permanent', 'active', '100-Day Streak', 'Focused 100 days in a row.', 'focus-streak-100', 90),
  ('focus-together:first', 'social', 'common', 'achievement', 'permanent', 'planned', 'First Focus Together', 'Your first session focused together with others.', 'focus-together-first', 100),
  ('focus-buddy', 'social', 'common', 'achievement', 'permanent', 'planned', 'Focus Buddy', 'Focused together with a friend.', 'focus-buddy', 110),
  ('community-contributor', 'social', 'rare', 'achievement', 'permanent', 'planned', 'Community Contributor', 'Helped a Community Tree grow.', 'community-contributor', 120);

INSERT INTO "achievement_definitions" ("id", "badge_id", "criterion", "target", "progress_visible") VALUES
  ('first-session', 'first-session', 'counted_sessions', 1, false),
  ('focus-hours:10', 'focus-hours:10', 'focused_minutes', 600, true),
  ('focus-hours:50', 'focus-hours:50', 'focused_minutes', 3000, true),
  ('focus-hours:100', 'focus-hours:100', 'focused_minutes', 6000, true),
  ('focus-hours:500', 'focus-hours:500', 'focused_minutes', 30000, true),
  ('focus-streak:3', 'focus-streak:3', 'longest_streak_days', 3, true),
  ('focus-streak:7', 'focus-streak:7', 'longest_streak_days', 7, true),
  ('focus-streak:30', 'focus-streak:30', 'longest_streak_days', 30, true),
  ('focus-streak:100', 'focus-streak:100', 'longest_streak_days', 100, true);
-- End of content seed.

-- Trees name a defined species (all existing rows name "signature", defined above).
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_species_fkey" FOREIGN KEY ("species") REFERENCES "tree_species"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
