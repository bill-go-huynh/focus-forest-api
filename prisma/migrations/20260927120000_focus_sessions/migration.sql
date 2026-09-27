-- CreateEnum
CREATE TYPE "focus_session_status" AS ENUM ('completed', 'ended_early', 'discarded');

-- CreateTable
CREATE TABLE "focus_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "submitted_ended_at" TIMESTAMP(3) NOT NULL,
    "planned_minutes" INTEGER NOT NULL,
    "pause_intervals" JSONB NOT NULL,
    "effective_ended_at" TIMESTAMP(3) NOT NULL,
    "focused_milliseconds" INTEGER NOT NULL,
    "paused_milliseconds" INTEGER NOT NULL,
    "status" "focus_session_status" NOT NULL,
    "local_date" DATE NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "config_version" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_sessions_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_started_at_idx" ON "focus_sessions"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_topic_id_idx" ON "focus_sessions"("user_id", "topic_id");

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_year_month_idx" ON "focus_sessions"("user_id", "year", "month");

-- AddForeignKey
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_topic_id_fkey" FOREIGN KEY ("user_id", "topic_id") REFERENCES "topics"("user_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_year_month_fkey" FOREIGN KEY ("user_id", "year", "month") REFERENCES "month_attribution_contexts"("user_id", "year", "month") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Technical integrity of the derived values (docs/06 → FocusSession).
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_planned_minutes_check"
CHECK ("planned_minutes" BETWEEN 1 AND 1440);
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_times_check"
CHECK ("started_at" <= "effective_ended_at" AND "effective_ended_at" <= "submitted_ended_at");
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_durations_check"
CHECK ("focused_milliseconds" >= 0 AND "paused_milliseconds" >= 0
  AND "focused_milliseconds" <= "planned_minutes" * 60000);
