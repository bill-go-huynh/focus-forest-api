-- Phase 3 month closure and forest progression (docs/06_DOMAIN_MODEL.md → Product
-- configuration). A new version holds the active version's values plus the new keys, and becomes
-- the active one. Existing versions are never changed.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "session.monthGraceMinutes": 180,
      "forest.levelThresholds": [1, 3, 6, 12, 24],
      "forest.areaLevels": {"lake": 2, "mountains": 3, "night": 4, "seasonal": 5, "decorations": 6}
    }'::jsonb,
    'Phase 3: a 3-hour month-end grace period, and forest levels and areas (project defaults).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
