-- A6.5 Admin live operations: accounts kept off every leaderboard and team score (docs/09:
-- exclude abusive accounts), by staff with a reason. Removing the row restores the account.
-- CreateTable
CREATE TABLE "leaderboard_exclusions" (
    "user_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_exclusions_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "leaderboard_exclusions" ADD CONSTRAINT "leaderboard_exclusions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_exclusions" ADD CONSTRAINT "leaderboard_exclusions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "leaderboard_exclusions" ADD CONSTRAINT "leaderboard_exclusions_reason" CHECK (length(btrim("reason")) BETWEEN 3 AND 500);
