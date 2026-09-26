-- CreateEnum
CREATE TYPE "theme" AS ENUM ('system', 'light', 'dark');

-- CreateEnum
CREATE TYPE "notification_category" AS ENUM ('daily_goal_reminder', 'scheduled_focus_reminder', 'streak_reminder', 'event_start', 'event_ending_soon', 'friend_invite', 'focus_room_invite', 'challenge_update', 'badge_unlocked', 'monthly_recap_ready');

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" UUID NOT NULL,
    "theme" "theme" NOT NULL,
    "sound" BOOLEAN NOT NULL,
    "haptics" BOOLEAN NOT NULL,
    "reduced_motion" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "time" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","category")
);

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
