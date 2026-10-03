-- Phase 3 goals, rest days, streaks, recovery, and goal-based vitality (docs/06_DOMAIN_MODEL.md →
-- Product configuration). A new version holds the active version's values plus the new keys, and
-- becomes the active one. Existing versions are never changed.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "goal.dailyDefaultMinutes": 30,
      "restDay.maxPerWeek": 2,
      "restDay.allowSameDay": true,
      "streak.milestones": [3, 7, 14, 30, 60, 100],
      "recovery.mechanics": {"nextDaySession": {"minPreviousStreak": 3}},
      "recovery.limit": {"perMonth": 1},
      "vitality.goalConsistency": {"windowDays": 4, "metDaysRequired": 3}
    }'::jsonb,
    'Phase 3: goals, rest days, streak milestones, the next-day-session recovery (one per month after a 3-day streak), and Thriving from recent daily goals.'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
