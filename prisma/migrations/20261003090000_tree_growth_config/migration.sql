-- Phase 3 tree growth and vitality rules (docs/06_DOMAIN_MODEL.md → Product configuration,
-- docs/03_TREE_SYSTEM.md). A new version holds the active version's values plus the new keys,
-- and becomes the active one. Existing versions are never changed.
-- Units: minutes for durations, whole percents for rates and scores, hours for focus milestones.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "growth.stageThresholds": [120, 360, 720, 1200, 1800],
      "growth.dailySoftCap": 240,
      "growth.overCapRate": 40,
      "growth.firstMonthProration": {"floorPercent": 25},
      "growth.fullnessWeights": {"activeDays": 60, "weeklyConsistency": 40},
      "growth.fullnessTargets": {"activeDays": 24, "activeDaysPerWeek": 3},
      "growth.fullnessLevels": [15, 35, 55, 75, 95],
      "growth.blossomPoints": {"dailyGoal": 1, "weeklyGoal": 2},
      "growth.blossomThresholds": [1, 3, 6, 10, 15, 21, 28],
      "growth.richnessTiers": [180, 360, 600, 900, 1260],
      "growth.focusHourMilestones": [10, 25, 40],
      "vitality.rules": {"thrivingActiveRunDays": 2, "healthyWithinDays": 1, "stableWithinDays": 2}
    }'::jsonb,
    'Phase 3: tree growth (stages, daily soft cap, first-month proration, fullness, blossoms, richness, focus-hour milestones) and vitality, at the initial project defaults.'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
