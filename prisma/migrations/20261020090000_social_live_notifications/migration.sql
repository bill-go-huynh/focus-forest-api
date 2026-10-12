-- A6.3 Social, live, and recap notifications (spec §18): room invitations (a friend invited into a
-- gathering room may see and join it, private rooms included, until it starts), and configuration
-- version 9 with when an event's "ending soon" notice goes out.
-- CreateTable
CREATE TABLE "room_invites" (
    "room_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_invites_pkey" PRIMARY KEY ("room_id","invitee_id")
);

-- CreateIndex
CREATE INDEX "room_invites_invitee_id_idx" ON "room_invites"("invitee_id");

-- AddForeignKey
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "focus_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "room_invites" ADD CONSTRAINT "room_invites_not_self" CHECK ("invitee_id" <> "inviter_id");

-- Configuration version 9: the active values plus the "ending soon" notice, 48 hours before an
-- event ends (project default).
WITH created AS (
  INSERT INTO "product_config_versions" ("values", "note")
  SELECT
    "versions"."values" || '{"notifications.eventEndingSoonHours": 48}'::jsonb,
    'Phase 6: event ending-soon notice (project default).'
  FROM "active_product_config" AS "active"
  JOIN "product_config_versions" AS "versions" ON "versions"."version" = "active"."version"
  WHERE "active"."id" = true
  RETURNING "version"
)
INSERT INTO "active_product_config" ("id", "version", "activated_at")
SELECT true, "version", CURRENT_TIMESTAMP FROM created
ON CONFLICT ("id") DO UPDATE
SET "version" = EXCLUDED."version", "activated_at" = EXCLUDED."activated_at";
