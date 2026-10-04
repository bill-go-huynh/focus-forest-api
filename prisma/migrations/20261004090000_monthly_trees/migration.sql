-- Phase 3 monthly trees and session growth results (docs/06_DOMAIN_MODEL.md → MonthlyTree).
-- CreateEnum
CREATE TYPE "monthly_tree_status" AS ENUM ('growing', 'archived');

-- CreateEnum
CREATE TYPE "tree_stage" AS ENUM ('seed', 'sprout', 'young_tree', 'growing_tree', 'mature_tree', 'blooming_tree', 'final_form');

-- AlterTable
ALTER TABLE "focus_sessions" ADD COLUMN     "growth_result" JSONB;

-- CreateTable
CREATE TABLE "monthly_trees" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "monthly_tree_status" NOT NULL DEFAULT 'growing',
    "species" TEXT NOT NULL,
    "variation_seed" BIGINT NOT NULL,
    "config_version" INTEGER NOT NULL,
    "joined_on" DATE NOT NULL,
    "proration_numerator" INTEGER NOT NULL,
    "proration_denominator" INTEGER NOT NULL,
    "stage" "tree_stage" NOT NULL DEFAULT 'seed',
    "fullness_level" INTEGER NOT NULL DEFAULT 0,
    "blossom_level" INTEGER NOT NULL DEFAULT 0,
    "richness_tier" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_trees_pkey" PRIMARY KEY ("user_id","year","month")
);

-- CreateTable
CREATE TABLE "monthly_tree_traits" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "trait_id" TEXT NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL,
    "session_id" UUID,

    CONSTRAINT "monthly_tree_traits_pkey" PRIMARY KEY ("user_id","year","month","trait_id")
);

-- AddForeignKey
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_user_id_year_month_fkey" FOREIGN KEY ("user_id", "year", "month") REFERENCES "month_attribution_contexts"("user_id", "year", "month") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_config_version_fkey" FOREIGN KEY ("config_version") REFERENCES "product_config_versions"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monthly_tree_traits" ADD CONSTRAINT "monthly_tree_traits_user_id_year_month_fkey" FOREIGN KEY ("user_id", "year", "month") REFERENCES "monthly_trees"("user_id", "year", "month") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity the domain relies on.
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_variation_seed_check"
CHECK ("variation_seed" BETWEEN 0 AND 4294967295);
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_levels_check"
CHECK ("fullness_level" >= 0 AND "blossom_level" >= 0 AND "richness_tier" >= 0);
ALTER TABLE "monthly_trees" ADD CONSTRAINT "monthly_trees_proration_check"
CHECK ("proration_denominator" > 0 AND "proration_numerator" > 0
  AND "proration_numerator" <= "proration_denominator");
