-- Phase 3 month closure, archived trees, recaps, and highlighted notes (docs/06_DOMAIN_MODEL.md →
-- MonthlyTree, Forest, MonthlyRecap).
-- AlterTable
ALTER TABLE "focus_sessions" ADD COLUMN     "note_highlighted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "month_attribution_contexts" ADD COLUMN     "closed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "monthly_trees" ADD COLUMN     "archive" JSONB,
ADD COLUMN     "archived_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "monthly_recaps" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "ceremony_seen_at" TIMESTAMP(3),
    "recap_seen_at" TIMESTAMP(3),

    CONSTRAINT "monthly_recaps_pkey" PRIMARY KEY ("user_id","year","month")
);

-- AddForeignKey
ALTER TABLE "monthly_recaps" ADD CONSTRAINT "monthly_recaps_user_id_year_month_fkey" FOREIGN KEY ("user_id", "year", "month") REFERENCES "monthly_trees"("user_id", "year", "month") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity the domain relies on.
ALTER TABLE "month_attribution_contexts" ADD CONSTRAINT "month_attribution_contexts_closed_at_check"
CHECK ("closed_at" IS NULL OR "closed_at" >= "ends_at");
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_archive_check"
CHECK (("status" = 'growing' AND "archived_at" IS NULL AND "archive" IS NULL)
  OR ("status" = 'archived' AND "archived_at" IS NOT NULL AND "archive" IS NOT NULL));
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_note_highlighted_check"
CHECK (NOT "note_highlighted" OR ("note" IS NOT NULL AND "note" <> ''));

-- An archived tree is a permanent snapshot: nothing may change it, its traits, or its recap
-- (only the recap's seen times are set, once each). Deleting the user still removes them.
CREATE FUNCTION "monthly_trees_archived_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'an archived monthly tree cannot change';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "monthly_trees_archived_immutable" BEFORE UPDATE ON "monthly_trees"
FOR EACH ROW WHEN (OLD."status" = 'archived')
EXECUTE FUNCTION "monthly_trees_archived_immutable"();

CREATE FUNCTION "monthly_tree_traits_archived_immutable"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "monthly_trees" AS "tree"
    WHERE "tree"."user_id" = NEW."user_id" AND "tree"."year" = NEW."year"
      AND "tree"."month" = NEW."month" AND "tree"."status" = 'archived'
  ) THEN
    RAISE EXCEPTION 'the traits of an archived monthly tree cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "monthly_tree_traits_archived_immutable"
BEFORE INSERT OR UPDATE ON "monthly_tree_traits"
FOR EACH ROW EXECUTE FUNCTION "monthly_tree_traits_archived_immutable"();

CREATE FUNCTION "monthly_recaps_for_archived_trees"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "monthly_trees" AS "tree"
    WHERE "tree"."user_id" = NEW."user_id" AND "tree"."year" = NEW."year"
      AND "tree"."month" = NEW."month" AND "tree"."status" = 'archived'
  ) THEN
    RAISE EXCEPTION 'a monthly recap needs an archived tree';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "monthly_recaps_for_archived_trees" BEFORE INSERT ON "monthly_recaps"
FOR EACH ROW EXECUTE FUNCTION "monthly_recaps_for_archived_trees"();

CREATE FUNCTION "monthly_recaps_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."year" IS DISTINCT FROM OLD."year"
    OR NEW."month" IS DISTINCT FROM OLD."month" OR NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."ceremony_seen_at" IS NOT NULL
      AND NEW."ceremony_seen_at" IS DISTINCT FROM OLD."ceremony_seen_at")
    OR (OLD."recap_seen_at" IS NOT NULL
      AND NEW."recap_seen_at" IS DISTINCT FROM OLD."recap_seen_at") THEN
    RAISE EXCEPTION 'a monthly recap cannot change, except to record when it was first seen';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "monthly_recaps_immutable" BEFORE UPDATE ON "monthly_recaps"
FOR EACH ROW EXECUTE FUNCTION "monthly_recaps_immutable"();
