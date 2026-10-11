-- A5.8 Leaderboards (spec §16, docs/02 Leaderboards, docs/06 Leaderboard): opt-in visibility (off by
-- default), event boards with optional teams, and the fair score's configuration. Boards are
-- derived on read from counted sessions; nothing here stores a ranking.
-- AlterTable
ALTER TABLE "event_participations" ADD COLUMN     "team_id" TEXT;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "leaderboard" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "privacy_settings" ADD COLUMN     "leaderboards" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "event_teams" (
    "event_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_teams_pkey" PRIMARY KEY ("event_id","id")
);

-- AddForeignKey
ALTER TABLE "event_participations" ADD CONSTRAINT "event_participations_event_id_team_id_fkey" FOREIGN KEY ("event_id", "team_id") REFERENCES "event_teams"("event_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_teams" ADD CONSTRAINT "event_teams_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "event_teams" ADD CONSTRAINT "event_teams_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Configuration version 7: the active values plus the fair score (project defaults). Focus time
-- is never the only weight (spec §16.4); each day counts at most two hours of focus.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "leaderboard.scoreWeights": {"consistency": 30, "goals": 30, "activeDays": 20, "focusTime": 20},
      "leaderboard.dailyFocusCapMinutes": 120
    }'::jsonb,
    'Phase 5: leaderboard fair score (project defaults).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
