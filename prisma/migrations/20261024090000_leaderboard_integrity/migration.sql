-- A7.3 Leaderboard integrity: the flags staff dismissed (by evidence key, with a reason), and
-- configuration version 11 with the flags' thresholds (project defaults, owner decision 8).
-- CreateTable
CREATE TABLE "integrity_dismissals" (
    "user_id" UUID NOT NULL,
    "flag_key" TEXT NOT NULL,
    "admin_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrity_dismissals_pkey" PRIMARY KEY ("user_id","flag_key")
);

-- AddForeignKey
ALTER TABLE "integrity_dismissals" ADD CONSTRAINT "integrity_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrity_dismissals" ADD CONSTRAINT "integrity_dismissals_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A reason says why; a key names the evidence.
ALTER TABLE "integrity_dismissals" ADD CONSTRAINT "integrity_dismissals_reason_length"
  CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500);
ALTER TABLE "integrity_dismissals" ADD CONSTRAINT "integrity_dismissals_flag_key_format"
  CHECK ("flag_key" ~ '^(overlap|day|late|spike):');

-- Configuration version 11: the active values plus the integrity thresholds.
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{
      "integrity.lookbackDays": 28,
      "integrity.maxDailyFocusMinutes": 960,
      "integrity.lateSubmissionHours": 72,
      "integrity.spike": {"ratio": 5, "minMinutes": 600}
    }'::jsonb,
    'Phase 7: leaderboard integrity flags (project defaults).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
