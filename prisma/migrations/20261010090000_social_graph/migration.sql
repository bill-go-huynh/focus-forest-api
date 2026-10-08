-- A5.1 Social graph and privacy (docs/06 Social entities, spec §13.1, §19). Follow first: no
-- approval, and a mutual follow is a friendship. A block overrides everything in both directions.
-- Privacy is per category; a user without a row has the defaults defined in the API code.

-- CreateEnum
CREATE TYPE "privacy_level" AS ENUM ('public', 'friends', 'private');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "username" TEXT;

-- CreateTable
CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "followee_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id","followee_id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "privacy_settings" (
    "user_id" UUID NOT NULL,
    "profile" "privacy_level" NOT NULL,
    "forest" "privacy_level" NOT NULL,
    "statistics" "privacy_level" NOT NULL,
    "badges" "privacy_level" NOT NULL,
    "current_tree" "privacy_level" NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "follows_follower_id_created_at_idx" ON "follows"("follower_id", "created_at");

-- CreateIndex
CREATE INDEX "follows_followee_id_created_at_idx" ON "follows"("followee_id", "created_at");

-- CreateIndex
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

-- CreateIndex
CREATE INDEX "blocks_blocker_id_created_at_idx" ON "blocks"("blocker_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Usernames are stored lowercase; the API normalizes and reserves names before writing.
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("username" ~ '^[a-z0-9_]{3,20}$');

ALTER TABLE "follows" ADD CONSTRAINT "follows_not_self" CHECK ("follower_id" <> "followee_id");
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_not_self" CHECK ("blocker_id" <> "blocked_id");

-- A follow can never exist next to a block. The API also takes a lock per pair of users so a
-- follow and a block that race are serialized (this check alone cannot see an uncommitted block).
CREATE FUNCTION "follows_refuse_while_blocked"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "blocks"
    WHERE ("blocker_id" = NEW."follower_id" AND "blocked_id" = NEW."followee_id")
       OR ("blocker_id" = NEW."followee_id" AND "blocked_id" = NEW."follower_id")
  ) THEN
    RAISE EXCEPTION 'A follow cannot exist while one user has blocked the other.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "follows_refuse_while_blocked"
  BEFORE INSERT OR UPDATE ON "follows"
  FOR EACH ROW EXECUTE FUNCTION "follows_refuse_while_blocked"();
