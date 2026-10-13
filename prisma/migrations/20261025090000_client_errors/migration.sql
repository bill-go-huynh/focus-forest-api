-- A7.4 Crash and error reports from the apps (self-built monitoring, owner decision 1): no user,
-- no address, text cut, pruned after 30 days; and configuration version 12 with their rate limit.
-- CreateTable
CREATE TABLE "client_errors" (
    "id" UUID NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "screen" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,

    CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_errors_received_at_idx" ON "client_errors"("received_at");


ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_kind" CHECK ("kind" IN ('crash', 'error'));
ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_platform" CHECK ("platform" IN ('ios', 'android'));
ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_text_lengths" CHECK (
  char_length("message") BETWEEN 1 AND 500
  AND ("stack" IS NULL OR char_length("stack") <= 4000)
  AND char_length("app_version") BETWEEN 1 AND 32
  AND ("screen" IS NULL OR char_length("screen") BETWEEN 1 AND 100)
);

-- Configuration version 12: the active values plus the reports' rate limit.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{"rateLimit.clientErrors": {"limit": 60, "windowSeconds": 3600}}'::jsonb,
    'Phase 7: crash and error reports (project default).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
