-- A5.3 Reports and moderation (spec §19.3, docs/09 Reports and moderation): users report other
-- users; moderators resolve or dismiss reports with audited actions. Must exist when Social
-- launches.

-- CreateEnum
CREATE TYPE "report_category" AS ENUM ('account', 'username', 'avatar', 'bio', 'behavior');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('open', 'in_review', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "moderation_action" AS ENUM ('none', 'warn', 'reset_username', 'reset_bio', 'reset_avatar', 'suspend', 'ban');

-- AlterEnum
ALTER TYPE "admin_role" ADD VALUE 'moderator';

-- AlterEnum
ALTER TYPE "user_status" ADD VALUE 'banned';

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID,
    "target_id" UUID NOT NULL,
    "category" "report_category" NOT NULL,
    "details" TEXT,
    "status" "report_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "action" "moderation_action",
    "resolution_reason" TEXT,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_warnings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_id" UUID,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "acknowledged_at" TIMESTAMP(3),

    CONSTRAINT "user_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "reports_target_id_idx" ON "reports"("target_id");

-- CreateIndex
CREATE INDEX "reports_reporter_id_idx" ON "reports"("reporter_id");

-- CreateIndex
CREATE INDEX "user_warnings_user_id_created_at_idx" ON "user_warnings"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_warnings" ADD CONSTRAINT "user_warnings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_warnings" ADD CONSTRAINT "user_warnings_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "reports" ADD CONSTRAINT "reports_not_self" CHECK ("reporter_id" <> "target_id");
ALTER TABLE "reports" ADD CONSTRAINT "reports_details_short" CHECK (char_length("details") BETWEEN 1 AND 500);
-- Open: nothing decided. In review: a reviewer. Resolved: an action and a reason. Dismissed: a
-- reason and no action.
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolution_matches_status" CHECK (
  CASE "status"
    WHEN 'open' THEN "resolved_at" IS NULL AND "action" IS NULL AND "resolution_reason" IS NULL
    WHEN 'in_review' THEN "resolved_at" IS NULL AND "action" IS NULL AND "resolution_reason" IS NULL
    WHEN 'resolved' THEN "resolved_at" IS NOT NULL AND "action" IS NOT NULL AND "resolution_reason" IS NOT NULL
    WHEN 'dismissed' THEN "resolved_at" IS NOT NULL AND "action" IS NULL AND "resolution_reason" IS NOT NULL
  END
);
-- One unfinished report per reporter, reported user, and category: a repeat finds the first.
CREATE UNIQUE INDEX "reports_one_unfinished" ON "reports" ("reporter_id", "target_id", "category")
  WHERE "status" IN ('open', 'in_review');

ALTER TABLE "user_warnings" ADD CONSTRAINT "user_warnings_message_short" CHECK (char_length("message") BETWEEN 1 AND 500);
