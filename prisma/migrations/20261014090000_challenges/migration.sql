-- A5.5 Challenges (docs/06 Challenge, spec §15, docs/02 Challenges): personal, friend, and group
-- challenges from configured templates. Progress is derived from counted sessions; nothing here
-- counts focus. Adds `challenge.templates` to the Product configuration (version 6).

-- CreateEnum
CREATE TYPE "challenge_kind" AS ENUM ('personal', 'friend', 'group');

-- CreateEnum
CREATE TYPE "challenge_measure" AS ENUM ('focus_minutes', 'sessions', 'active_days');

-- CreateEnum
CREATE TYPE "challenge_goal" AS ENUM ('each', 'shared');

-- CreateEnum
CREATE TYPE "challenge_place_status" AS ENUM ('invited', 'joined');

-- CreateTable
CREATE TABLE "challenges" (
    "id" UUID NOT NULL,
    "template_id" TEXT NOT NULL,
    "kind" "challenge_kind" NOT NULL,
    "measure" "challenge_measure" NOT NULL,
    "goal" "challenge_goal" NOT NULL,
    "target" INTEGER NOT NULL,
    "daily_minutes" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "max_participants" INTEGER NOT NULL,
    "config_version" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_participants" (
    "challenge_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "challenge_place_status" NOT NULL,
    "invited_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "joined_at" TIMESTAMP(3),

    CONSTRAINT "challenge_participants_pkey" PRIMARY KEY ("challenge_id","user_id")
);

-- CreateIndex
CREATE INDEX "challenge_participants_user_id_status_idx" ON "challenge_participants"("user_id", "status");

-- AddForeignKey
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "challenges" ADD CONSTRAINT "challenges_window" CHECK ("end_date" = "start_date" + ("days" - 1));
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_terms" CHECK (
  "target" >= 1 AND "days" BETWEEN 1 AND 31 AND "max_participants" BETWEEN 1 AND 10
  AND (("measure" = 'active_days') = ("daily_minutes" >= 1))
  AND ("kind" <> 'personal' OR ("max_participants" = 1 AND "goal" = 'each'))
);
ALTER TABLE "challenge_participants" ADD CONSTRAINT "challenge_participants_joined_at" CHECK (("status" = 'joined') = ("joined_at" IS NOT NULL));

-- Configuration version 6: the active values plus the challenge templates (project defaults).
-- Cooperative and consistency formats only: no "first to" races (docs/02 rule 13).
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "challenge.templates": [
        {"id": "seven-days-thirty-minutes", "kind": "personal", "measure": "active_days", "goal": "each", "target": 7, "dailyMinutes": 30, "days": 7, "maxParticipants": 1},
        {"id": "ten-hours-week", "kind": "personal", "measure": "focus_minutes", "goal": "each", "target": 600, "dailyMinutes": 0, "days": 7, "maxParticipants": 1},
        {"id": "thirty-sessions-month", "kind": "personal", "measure": "sessions", "goal": "each", "target": 30, "dailyMinutes": 0, "days": 30, "maxParticipants": 1},
        {"id": "steady-week-together", "kind": "friend", "measure": "active_days", "goal": "each", "target": 7, "dailyMinutes": 15, "days": 7, "maxParticipants": 5},
        {"id": "ten-hours-each", "kind": "friend", "measure": "focus_minutes", "goal": "each", "target": 600, "dailyMinutes": 0, "days": 14, "maxParticipants": 5},
        {"id": "team-fifty-hours", "kind": "group", "measure": "focus_minutes", "goal": "shared", "target": 3000, "dailyMinutes": 0, "days": 7, "maxParticipants": 10}
      ]
    }'::jsonb,
    'Phase 5: challenge templates (project defaults).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
