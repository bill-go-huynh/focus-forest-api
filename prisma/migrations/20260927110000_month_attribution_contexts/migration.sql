-- CreateTable
CREATE TABLE "month_attribution_contexts" (
    "user_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "month_attribution_contexts_pkey" PRIMARY KEY ("user_id","year","month")
);

-- CreateIndex
CREATE INDEX "month_attribution_contexts_user_id_starts_at_idx" ON "month_attribution_contexts"("user_id", "starts_at");

-- AddForeignKey
ALTER TABLE "month_attribution_contexts" ADD CONSTRAINT "month_attribution_contexts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Technical integrity: a calendar month, and a non-empty interval.
ALTER TABLE "month_attribution_contexts" ADD CONSTRAINT "month_attribution_contexts_month_check"
CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "month_attribution_contexts" ADD CONSTRAINT "month_attribution_contexts_interval_check"
CHECK ("starts_at" < "ends_at");
