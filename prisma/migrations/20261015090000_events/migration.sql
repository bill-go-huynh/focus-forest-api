-- A5.6 Events and missions (docs/06 Event, EventMission, EventParticipation; spec §11; docs/02
-- Events): time-bound content whose missions count normal counted sessions in the window, and
-- milestones whose rewards (event badge, cosmetic, event trait) are owned forever. No event is
-- seeded: which events run, and when, is a content decision.

-- CreateEnum
CREATE TYPE "event_mission_measure" AS ENUM ('focus_minutes', 'sessions', 'active_days', 'streak_days', 'focus_together_sessions');

-- AlterTable
ALTER TABLE "focus_sessions" ADD COLUMN     "event_result" JSONB;

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "artwork_id" TEXT NOT NULL,
    "status" "content_status" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "entry_min_sessions" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_missions" (
    "event_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "measure" "event_mission_measure" NOT NULL,
    "target" INTEGER NOT NULL,
    "daily_minutes" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_missions_pkey" PRIMARY KEY ("event_id","id")
);

-- CreateTable
CREATE TABLE "event_milestones" (
    "event_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "required_missions" INTEGER NOT NULL,
    "badge_id" TEXT,
    "cosmetic_id" TEXT,
    "trait_id" TEXT,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_milestones_pkey" PRIMARY KEY ("event_id","id")
);

-- CreateTable
CREATE TABLE "event_participations" (
    "user_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_participations_pkey" PRIMARY KEY ("user_id","event_id")
);

-- CreateTable
CREATE TABLE "event_milestone_grants" (
    "user_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "milestone_id" TEXT NOT NULL,
    "reached_at" TIMESTAMP(3) NOT NULL,
    "trait_year" INTEGER,
    "trait_month" INTEGER,

    CONSTRAINT "event_milestone_grants_pkey" PRIMARY KEY ("user_id","event_id","milestone_id")
);

-- AddForeignKey
ALTER TABLE "event_missions" ADD CONSTRAINT "event_missions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_cosmetic_id_fkey" FOREIGN KEY ("cosmetic_id") REFERENCES "cosmetic_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_participations" ADD CONSTRAINT "event_participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_participations" ADD CONSTRAINT "event_participations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestone_grants" ADD CONSTRAINT "event_milestone_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestone_grants" ADD CONSTRAINT "event_milestone_grants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_milestone_grants" ADD CONSTRAINT "event_milestone_grants_event_id_milestone_id_fkey" FOREIGN KEY ("event_id", "milestone_id") REFERENCES "event_milestones"("event_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "events" ADD CONSTRAINT "events_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "events" ADD CONSTRAINT "events_window" CHECK ("starts_at" < "ends_at");
ALTER TABLE "events" ADD CONSTRAINT "events_entry" CHECK ("entry_min_sessions" >= 0);
ALTER TABLE "event_missions" ADD CONSTRAINT "event_missions_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "event_missions" ADD CONSTRAINT "event_missions_terms" CHECK ("target" >= 1 AND "daily_minutes" >= 0 AND ("measure" = 'active_days' OR "daily_minutes" = 0));
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_required" CHECK ("required_missions" >= 1);
-- An event trait names its own event.
ALTER TABLE "event_milestones" ADD CONSTRAINT "event_milestones_trait" CHECK ("trait_id" IS NULL OR "trait_id" = 'event:' || "event_id");
ALTER TABLE "event_milestone_grants" ADD CONSTRAINT "event_milestone_grants_trait_month" CHECK (("trait_year" IS NULL) = ("trait_month" IS NULL));
