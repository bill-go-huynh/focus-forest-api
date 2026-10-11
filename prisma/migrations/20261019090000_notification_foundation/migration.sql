-- A6.1 Notification foundation (spec §18, docs/02 Notifications, docs/07 device registration,
-- docs/08 §6 background jobs and push, docs/11 Notification control): push devices, the focus
-- lease (no notification during focus), a Postgres-backed job queue, and the notification outbox
-- every notification goes through. Configuration version 8 holds the delivery limits.
-- CreateEnum
CREATE TYPE "device_platform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "push_devices" (
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "device_platform" NOT NULL,
    "app_version" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "focus_leases" (
    "user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_leases_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL,
    "dedupe_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "subject" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "requested" BOOLEAN NOT NULL,
    "not_before" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "held_for_focus" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "jobs_run_at_idx" ON "jobs"("run_at");

-- CreateIndex
CREATE INDEX "notification_outbox_status_not_before_idx" ON "notification_outbox"("status", "not_before");

-- CreateIndex
CREATE INDEX "notification_outbox_user_id_status_sent_at_idx" ON "notification_outbox"("user_id", "status", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_user_id_dedupe_key_key" ON "notification_outbox"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_leases" ADD CONSTRAINT "focus_leases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_token_format" CHECK ("token" ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$');
ALTER TABLE "focus_leases" ADD CONSTRAINT "focus_leases_window" CHECK ("started_at" < "ends_at");
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_done_once" CHECK ("completed_at" IS NULL OR "failed_at" IS NULL);
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_copy" CHECK (btrim("title") <> '' AND btrim("body") <> '' AND "link" LIKE '/%');
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_sent" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_reason" CHECK ("status" IN ('pending', 'sent') OR "reason" IS NOT NULL);

-- Configuration version 8: the active values plus the notification limits (owner decisions
-- 2026-10-11): at most two informational notices a local day, only from 09:00 to 21:00 local,
-- and a 30-minute grace after a focus lease for pauses.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "notifications.maxUnrequestedPerDay": 2,
      "notifications.informationalHours": {"start": 9, "end": 21},
      "notifications.focusLeaseGraceMinutes": 30
    }'::jsonb,
    'Phase 6: notification limits (owner decisions 2026-10-11).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
