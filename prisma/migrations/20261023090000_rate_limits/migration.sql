-- A7.2 Rate limits: hits per bucket in fixed windows (hashed keys; pruned after a day), and
-- configuration version 10 with the limits (project defaults, Phase 7 owner decision 2).
-- CreateTable
CREATE TABLE "rate_limit_windows" (
    "bucket" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("bucket","window_start")
);

-- CreateIndex
CREATE INDEX "rate_limit_windows_window_start_idx" ON "rate_limit_windows"("window_start");


-- A hit count is never negative.
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_hits_positive" CHECK ("hits" > 0);

-- Configuration version 10: the active values plus the rate limits.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "rateLimit.signUp": {"limit": 10, "windowSeconds": 3600},
      "rateLimit.signIn": {"limit": 10, "windowSeconds": 900},
      "rateLimit.refresh": {"limit": 120, "windowSeconds": 3600},
      "rateLimit.deleteAttempts": {"limit": 5, "windowSeconds": 3600},
      "rateLimit.reports": {"limit": 20, "windowSeconds": 86400},
      "rateLimit.follows": {"limit": 200, "windowSeconds": 3600},
      "rateLimit.reactions": {"limit": 300, "windowSeconds": 3600},
      "rateLimit.invites": {"limit": 50, "windowSeconds": 3600},
      "rateLimit.roomCodes": {"limit": 20, "windowSeconds": 3600},
      "rateLimit.search": {"limit": 120, "windowSeconds": 3600},
      "rateLimit.analytics": {"limit": 300, "windowSeconds": 3600}
    }'::jsonb,
    'Phase 7: rate limits (project defaults).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
