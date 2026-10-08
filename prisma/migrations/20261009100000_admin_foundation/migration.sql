-- CR.3 Early admin foundation (docs/09 → Early admin: admin auth and roles, audit log). Admins
-- are not app users: their own table, credentials, and tokens. Roles start with `admin` and
-- `support`; `moderator` and `content` arrive with the phases that need them.

-- CreateEnum
CREATE TYPE "admin_role" AS ENUM ('admin', 'support');

-- CreateEnum
CREATE TYPE "admin_status" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "admin_role" NOT NULL,
    "status" "admin_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sign_in_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_users_email_lowercase" CHECK ("email" = lower("email"))
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_audit_log_details_object" CHECK (jsonb_typeof("details") = 'object')
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The audit log is append-only: who did what, when, and why is never rewritten or removed.
CREATE FUNCTION "admin_audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the admin audit log is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "admin_audit_log_append_only" BEFORE UPDATE OR DELETE ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION "admin_audit_log_append_only"();
