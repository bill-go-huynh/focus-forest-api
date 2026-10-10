-- A5.4 Focus Together (docs/06 FocusRoom, spec §14, docs/07 §6): rooms, places, and the
-- synchronized start. Each participant's focus stays their own FocusSession; the room grows no
-- tree. Activates the Focus Together badges with their two criteria.

-- CreateEnum
CREATE TYPE "room_visibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "room_status" AS ENUM ('lobby', 'in_session', 'closed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "achievement_criterion" ADD VALUE 'focus_together_sessions';
ALTER TYPE "achievement_criterion" ADD VALUE 'focus_together_with_friend';

-- CreateTable
CREATE TABLE "focus_rooms" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "max_participants" INTEGER NOT NULL,
    "visibility" "room_visibility" NOT NULL,
    "status" "room_status" NOT NULL DEFAULT 'lobby',
    "created_at" TIMESTAMP(3) NOT NULL,
    "starts_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "focus_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_participants" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "ready_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),
    "in_session" BOOLEAN NOT NULL DEFAULT false,
    "session_id" UUID,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "room_participants_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "focus_rooms_code_key" ON "focus_rooms"("code");

-- CreateIndex
CREATE INDEX "focus_rooms_status_visibility_created_at_idx" ON "focus_rooms"("status", "visibility", "created_at");

-- CreateIndex
CREATE INDEX "room_participants_user_id_left_at_idx" ON "room_participants"("user_id", "left_at");

-- CreateIndex
CREATE UNIQUE INDEX "room_participants_user_id_session_id_key" ON "room_participants"("user_id", "session_id");

-- AddForeignKey
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "focus_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_user_id_session_id_fkey" FOREIGN KEY ("user_id", "session_id") REFERENCES "focus_sessions"("user_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_code_format" CHECK ("code" ~ '^[A-HJ-NP-Z2-9]{6}$');
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_name_length" CHECK (char_length("name") BETWEEN 1 AND 50);
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_topic_length" CHECK (char_length("topic") BETWEEN 1 AND 50);
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_duration_bounds" CHECK ("duration_minutes" BETWEEN 5 AND 180);
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_participant_bounds" CHECK ("max_participants" BETWEEN 2 AND 10);
-- A started room has its start time; a lobby has none.
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_start_matches_status" CHECK (
  ("status" = 'lobby' AND "starts_at" IS NULL)
  OR ("status" = 'in_session' AND "starts_at" IS NOT NULL)
  OR "status" = 'closed'
);
ALTER TABLE "focus_rooms" ADD CONSTRAINT "focus_rooms_closed_at" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));
-- Only someone who started with the room completes it, and a completion has its session.
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_completion" CHECK (
  ("session_id" IS NULL) = ("completed_at" IS NULL) AND ("session_id" IS NULL OR "in_session")
);

-- Content seed: A5.4 makes the Focus Together badges earnable (seeded as planned in A4.1).
UPDATE "badge_definitions" SET "status" = 'active' WHERE "id" IN ('focus-together:first', 'focus-buddy');

INSERT INTO "achievement_definitions" ("id", "badge_id", "criterion", "target", "progress_visible") VALUES
  ('focus-together:first', 'focus-together:first', 'focus_together_sessions', 1, false),
  ('focus-buddy', 'focus-buddy', 'focus_together_with_friend', 1, false);
-- End of content seed.
