-- A5.9 Seasonal content (spec §17, docs/03 §10, docs/06 SeasonalTheme / LimitedCollection):
-- hemisphere-aware themes that change environment and atmosphere, never a tree's earned structure,
-- and limited collections earned with normal focus and owned forever. No theme is seeded: which
-- themes run, for which hemisphere, and when, is a content decision.
-- CreateEnum
CREATE TYPE "hemisphere" AS ENUM ('north', 'south');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hemisphere" "hemisphere";

-- CreateTable
CREATE TABLE "seasonal_themes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "environment_id" TEXT NOT NULL,
    "hemisphere" "hemisphere",
    "status" "content_status" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "seasonal_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasonal_rewards" (
    "theme_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "badge_id" TEXT,
    "cosmetic_id" TEXT,
    "required_active_days" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "seasonal_rewards_pkey" PRIMARY KEY ("theme_id","id")
);

-- AddForeignKey
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "seasonal_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_cosmetic_id_fkey" FOREIGN KEY ("cosmetic_id") REFERENCES "cosmetic_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "seasonal_themes" ADD CONSTRAINT "seasonal_themes_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "seasonal_themes" ADD CONSTRAINT "seasonal_themes_window" CHECK ("starts_at" < "ends_at");
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_id_format" CHECK ("id" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
-- Exactly one item per reward, earned with at least one active day.
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_item" CHECK (("badge_id" IS NULL) <> ("cosmetic_id" IS NULL));
ALTER TABLE "seasonal_rewards" ADD CONSTRAINT "seasonal_rewards_days" CHECK ("required_active_days" >= 1);
