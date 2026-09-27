-- Phase 2 session rules (docs/06_DOMAIN_MODEL.md → Product configuration).
-- A new version holds every registry key and becomes the active one. Existing
-- versions are never changed.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  VALUES (
    '{"session.minValidMinutes": 5, "session.maxPauseMinutes": 30}'::jsonb,
    'Phase 2: session.minValidMinutes and session.maxPauseMinutes, at the documented defaults.'
  )
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
