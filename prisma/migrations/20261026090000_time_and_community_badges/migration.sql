-- Final review Q1 and Q2 (owner decision 2026-10-15; docs/06 Badge): the time-based badges of
-- spec §9.1 (Early Bird, Night Owl, Weekend Warrior) and Community Contributor, with their four
-- criteria. All are derived from stored sessions and Community Tree contributions; nothing is
-- counted separately.

-- AlterEnum
ALTER TYPE "achievement_criterion" ADD VALUE 'sessions_before_7';
ALTER TYPE "achievement_criterion" ADD VALUE 'sessions_after_22';
ALTER TYPE "achievement_criterion" ADD VALUE 'full_weekends';
ALTER TYPE "achievement_criterion" ADD VALUE 'community_contributions';

-- Content seed: three time-based badges, and Community Contributor (seeded as planned in A4.1).
INSERT INTO "badge_definitions" ("id", "category", "rarity", "source", "availability", "status", "name", "description", "artwork_id", "sort_order") VALUES
  ('early-bird', 'time_based', 'common', 'achievement', 'permanent', 'active', 'Early Bird', '10 focus sessions started before 7 in the morning.', 'early-bird', 92),
  ('night-owl', 'time_based', 'common', 'achievement', 'permanent', 'active', 'Night Owl', '10 focus sessions started at 10 in the evening or later.', 'night-owl', 94),
  ('weekend-warrior', 'time_based', 'common', 'achievement', 'permanent', 'active', 'Weekend Warrior', 'Focused on both days of 4 weekends.', 'weekend-warrior', 96);

UPDATE "badge_definitions" SET "status" = 'active' WHERE "id" = 'community-contributor';

INSERT INTO "achievement_definitions" ("id", "badge_id", "criterion", "target", "progress_visible") VALUES
  ('early-bird', 'early-bird', 'sessions_before_7', 10, true),
  ('night-owl', 'night-owl', 'sessions_after_22', 10, true),
  ('weekend-warrior', 'weekend-warrior', 'full_weekends', 4, true),
  ('community-contributor', 'community-contributor', 'community_contributions', 1, false);
-- End of content seed.
