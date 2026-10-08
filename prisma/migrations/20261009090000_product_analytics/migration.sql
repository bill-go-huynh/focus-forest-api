-- CR.1 Product analytics (docs/08 §6): operational events for the Core Loop Checkpoint. Never
-- product truth: no product feature reads this table (Insights, growth, streaks, and rewards stay
-- derived from sessions, docs/06). No free text: a closed allowlist of names and integer props.

-- Sharing is on by default for the checkpoint and can be turned off in Settings.
ALTER TABLE "user_preferences" ADD COLUMN     "share_usage_data" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "local_date" DATE NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "analytics_events_name_known" CHECK ("name" IN ('app_opened', 'app_foregrounded', 'focus_started', 'focus_cancelled', 'tree_details_opened', 'forest_opened', 'recap_opened', 'insights_opened')),
    CONSTRAINT "analytics_events_platform_known" CHECK ("platform" IN ('ios', 'android', 'web')),
    CONSTRAINT "analytics_events_app_version_short" CHECK (char_length("app_version") BETWEEN 1 AND 32),
    CONSTRAINT "analytics_events_props_object" CHECK (jsonb_typeof("props") = 'object')
);

-- CreateIndex
CREATE INDEX "analytics_events_user_id_local_date_idx" ON "analytics_events"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "analytics_events_name_occurred_at_idx" ON "analytics_events"("name", "occurred_at");

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
