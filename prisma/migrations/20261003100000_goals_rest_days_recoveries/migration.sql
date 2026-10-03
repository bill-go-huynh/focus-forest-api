-- Phase 3 goals, rest days, and streak recoveries (docs/06_DOMAIN_MODEL.md).
-- CreateEnum
CREATE TYPE "weekly_goal_type" AS ENUM ('focused_minutes', 'session_count');

-- CreateEnum
CREATE TYPE "streak_recovery_mechanic" AS ENUM ('next_day_session');

-- CreateTable
CREATE TABLE "daily_goal_settings" (
    "user_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_goal_settings_pkey" PRIMARY KEY ("user_id","effective_from")
);

-- CreateTable
CREATE TABLE "weekly_goal_settings" (
    "user_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "type" "weekly_goal_type",
    "target" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_goal_settings_pkey" PRIMARY KEY ("user_id","effective_from")
);

-- CreateTable
CREATE TABLE "rest_days" (
    "user_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rest_days_pkey" PRIMARY KEY ("user_id","date")
);

-- CreateTable
CREATE TABLE "streak_recoveries" (
    "user_id" UUID NOT NULL,
    "missed_date" DATE NOT NULL,
    "return_date" DATE NOT NULL,
    "mechanic" "streak_recovery_mechanic" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streak_recoveries_pkey" PRIMARY KEY ("user_id","missed_date")
);

-- AddForeignKey
ALTER TABLE "daily_goal_settings" ADD CONSTRAINT "daily_goal_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_goal_settings" ADD CONSTRAINT "weekly_goal_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rest_days" ADD CONSTRAINT "rest_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streak_recoveries" ADD CONSTRAINT "streak_recoveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity the domain relies on. Bounds are technical limits, not Product configuration.
ALTER TABLE "daily_goal_settings" ADD CONSTRAINT "daily_goal_settings_minutes_check"
CHECK ("minutes" BETWEEN 1 AND 1440);
ALTER TABLE "weekly_goal_settings" ADD CONSTRAINT "weekly_goal_settings_monday_check"
CHECK (EXTRACT(ISODOW FROM "effective_from") = 1);
ALTER TABLE "weekly_goal_settings" ADD CONSTRAINT "weekly_goal_settings_target_check"
-- A cleared goal has neither type nor target. Checked explicitly: a comparison with NULL would
-- otherwise let half of a goal through.
CHECK (("type" IS NULL AND "target" IS NULL)
  OR ("type" IS NOT NULL AND "target" IS NOT NULL AND (
    ("type" = 'focused_minutes' AND "target" BETWEEN 1 AND 10080)
    OR ("type" = 'session_count' AND "target" BETWEEN 1 AND 500))));
ALTER TABLE "streak_recoveries" ADD CONSTRAINT "streak_recoveries_return_date_check"
CHECK ("return_date" = "missed_date" + 1);
