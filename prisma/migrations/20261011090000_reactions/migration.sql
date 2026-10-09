-- A5.2 Reactions (docs/06 Reaction, spec §13.4): lightweight and positive, never text. Each kind
-- at most once per reactor and target. Targets are checked by the API against the owner's privacy.

-- CreateEnum
CREATE TYPE "reaction_target_type" AS ENUM ('forest', 'tree', 'badge');

-- CreateEnum
CREATE TYPE "reaction_kind" AS ENUM ('fire', 'sprout', 'clap', 'heart', 'sparkles');

-- CreateTable
CREATE TABLE "reactions" (
    "id" UUID NOT NULL,
    "reactor_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "target_type" "reaction_target_type" NOT NULL,
    "target_key" TEXT NOT NULL,
    "reaction" "reaction_kind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reactions_owner_id_target_type_target_key_idx" ON "reactions"("owner_id", "target_type", "target_key");

-- CreateIndex
CREATE INDEX "reactions_owner_id_created_at_idx" ON "reactions"("owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reactions_reactor_id_owner_id_target_type_target_key_reacti_key" ON "reactions"("reactor_id", "owner_id", "target_type", "target_key", "reaction");

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_reactor_id_fkey" FOREIGN KEY ("reactor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "reactions" ADD CONSTRAINT "reactions_not_self" CHECK ("reactor_id" <> "owner_id");
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_target_key_format" CHECK (
  ("target_type" = 'forest' AND "target_key" = '')
  OR ("target_type" = 'tree' AND "target_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
  OR ("target_type" = 'badge' AND "target_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$')
);

-- A reaction can never exist next to a block. The API serializes reactions and blocks of a pair
-- with the same advisory lock as follows (A5.1); this catches anything else.
CREATE FUNCTION "reactions_refuse_while_blocked"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "blocks"
    WHERE ("blocker_id" = NEW."reactor_id" AND "blocked_id" = NEW."owner_id")
       OR ("blocker_id" = NEW."owner_id" AND "blocked_id" = NEW."reactor_id")
  ) THEN
    RAISE EXCEPTION 'A reaction cannot exist while one user has blocked the other.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reactions_refuse_while_blocked"
  BEFORE INSERT OR UPDATE ON "reactions"
  FOR EACH ROW EXECUTE FUNCTION "reactions_refuse_while_blocked"();
