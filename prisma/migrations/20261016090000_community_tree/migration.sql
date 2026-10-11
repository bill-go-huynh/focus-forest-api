-- A5.7 Community Tree (spec §12, docs/06 CommunityTree, docs/12 Phase 15): a shared tree per event
-- that grows from the participants' focus minutes, reaches milestones once, and never loses
-- progress. Contributions are an append-only ledger that outlives the accounts that made them
-- (docs/06 User lifecycle). No Community Tree is seeded: content is the owner's decision.
-- CreateEnum
CREATE TYPE "community_stage" AS ENUM ('seedling', 'growing_tree', 'bloom', 'final_form');

-- CreateTable
CREATE TABLE "community_trees" (
    "event_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "artwork_id" TEXT NOT NULL,
    "total_minutes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "community_trees_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "community_milestones" (
    "event_id" TEXT NOT NULL,
    "stage" "community_stage" NOT NULL,
    "threshold_minutes" BIGINT NOT NULL,
    "badge_id" TEXT,
    "cosmetic_id" TEXT,
    "reached_at" TIMESTAMP(3),

    CONSTRAINT "community_milestones_pkey" PRIMARY KEY ("event_id","stage")
);

-- CreateTable
CREATE TABLE "community_contributions" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" UUID,
    "session_id" UUID NOT NULL,
    "minutes" INTEGER NOT NULL,
    "contributed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_reward_grants" (
    "user_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "stage" "community_stage" NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "celebrated_at" TIMESTAMP(3),

    CONSTRAINT "community_reward_grants_pkey" PRIMARY KEY ("user_id","event_id","stage")
);

-- CreateIndex
CREATE UNIQUE INDEX "community_contributions_event_id_user_id_session_id_key" ON "community_contributions"("event_id", "user_id", "session_id");

-- AddForeignKey
ALTER TABLE "community_trees" ADD CONSTRAINT "community_trees_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_milestones" ADD CONSTRAINT "community_milestones_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "community_trees"("event_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_milestones" ADD CONSTRAINT "community_milestones_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_milestones" ADD CONSTRAINT "community_milestones_cosmetic_id_fkey" FOREIGN KEY ("cosmetic_id") REFERENCES "cosmetic_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_contributions" ADD CONSTRAINT "community_contributions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "community_trees"("event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_contributions" ADD CONSTRAINT "community_contributions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_reward_grants" ADD CONSTRAINT "community_reward_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_reward_grants" ADD CONSTRAINT "community_reward_grants_event_id_stage_fkey" FOREIGN KEY ("event_id", "stage") REFERENCES "community_milestones"("event_id", "stage") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "community_trees" ADD CONSTRAINT "community_trees_total" CHECK ("total_minutes" >= 0);
ALTER TABLE "community_milestones" ADD CONSTRAINT "community_milestones_threshold" CHECK ("threshold_minutes" >= 1);
-- Every milestone shares a reward with the participants.
ALTER TABLE "community_milestones" ADD CONSTRAINT "community_milestones_reward" CHECK ("badge_id" IS NOT NULL OR "cosmetic_id" IS NOT NULL);
ALTER TABLE "community_contributions" ADD CONSTRAINT "community_contributions_minutes" CHECK ("minutes" >= 1);

-- The Community Tree never loses progress: the total never goes down.
CREATE FUNCTION "community_trees_never_shrink"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a community tree never loses progress';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "community_trees_never_shrink" BEFORE UPDATE ON "community_trees"
FOR EACH ROW WHEN (NEW."total_minutes" < OLD."total_minutes")
EXECUTE FUNCTION "community_trees_never_shrink"();

-- A milestone, once reached, stays reached with its first time.
CREATE FUNCTION "community_milestones_reached_once"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a reached community milestone cannot change';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "community_milestones_reached_once" BEFORE UPDATE ON "community_milestones"
FOR EACH ROW WHEN (OLD."reached_at" IS NOT NULL AND NEW."reached_at" IS DISTINCT FROM OLD."reached_at")
EXECUTE FUNCTION "community_milestones_reached_once"();

-- The ledger is append-only. The one change it accepts is forgetting a deleted account.
CREATE FUNCTION "community_contributions_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a community contribution is never removed';
  END IF;
  IF NEW."user_id" IS NOT NULL OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."session_id" IS DISTINCT FROM OLD."session_id"
    OR NEW."minutes" IS DISTINCT FROM OLD."minutes"
    OR NEW."contributed_at" IS DISTINCT FROM OLD."contributed_at" THEN
    RAISE EXCEPTION 'a community contribution cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "community_contributions_append_only" BEFORE UPDATE OR DELETE ON "community_contributions"
FOR EACH ROW EXECUTE FUNCTION "community_contributions_append_only"();
