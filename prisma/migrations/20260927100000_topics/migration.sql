-- Requirement: PostgreSQL 17 or later, in a UTF8 database, for the built-in "pg_c_utf8"
-- collation used by the active-name index below. Prisma does not run a migration in a
-- transaction, so this check runs first and fails before anything is created.
DO $$
BEGIN
  IF getdatabaseencoding() <> 'UTF8'
     OR NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'pg_c_utf8') THEN
    RAISE EXCEPTION 'Focus Forest needs PostgreSQL 17 or later with a UTF8 database (collation "pg_c_utf8"). Nothing was changed by this migration.';
  END IF;
END $$;


-- CreateEnum
CREATE TYPE "topic_status" AS ENUM ('active', 'archived');

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "status" "topic_status" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMP(3),
    "create_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateIndex
CREATE INDEX "topics_user_id_created_at_idx" ON "topics"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Active topic names are unique per user, ignoring case (docs/06 → Topic). Archived topics
-- do not hold their name. lower() runs under the built-in "pg_c_utf8" collation (Unicode
-- simple case mapping), so the rule depends neither on the database locale nor on an ICU
-- build: under "C", lower('ĐỌC') leaves "Đ" and "Ọ" unchanged. Names are stored trimmed and
-- in Unicode NFC by the API.
CREATE UNIQUE INDEX "topics_user_id_active_name_key" ON "topics"("user_id", lower("name" COLLATE "pg_c_utf8"))
WHERE "status" = 'active';

-- archived_at is set exactly when the topic is archived.
ALTER TABLE "topics" ADD CONSTRAINT "topics_archived_at_matches_status"
CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));
