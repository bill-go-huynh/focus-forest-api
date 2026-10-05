-- A4.2 achievements, badges, and showcase. Additive only: no existing row is changed.

-- The badges a session caused, stored with it and replayed unchanged. Sessions stored before
-- A4.2 keep null: nothing is reconstructed for them.
ALTER TABLE "focus_sessions" ADD COLUMN "progression_result" JSONB;

-- The badges a streak recovery caused (A4.2.G), stored with it: a repeated acceptance answers
-- the same. Recoveries stored before keep null.
ALTER TABLE "streak_recoveries" ADD COLUMN "progression_result" JSONB;

-- The user's ordered badge showcase: at most three owned badges, replaced as a whole.
CREATE TABLE "badge_showcase" (
    "user_id" UUID NOT NULL,
    "badge_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "badge_showcase_pkey" PRIMARY KEY ("user_id","badge_id"),
    CONSTRAINT "badge_showcase_position_check" CHECK ("position" BETWEEN 1 AND 3)
);

-- One badge per position.
CREATE UNIQUE INDEX "badge_showcase_user_id_position_key" ON "badge_showcase"("user_id", "position");

ALTER TABLE "badge_showcase" ADD CONSTRAINT "badge_showcase_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only an owned badge can be pinned. NO ACTION (checked at the end of the statement), so deleting
-- a user, which removes both the ownership and the showcase, succeeds.
ALTER TABLE "badge_showcase" ADD CONSTRAINT "badge_showcase_user_id_badge_id_fkey" FOREIGN KEY ("user_id", "badge_id") REFERENCES "user_badges"("user_id", "badge_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
