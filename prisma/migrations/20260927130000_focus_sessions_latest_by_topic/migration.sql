-- The latest session of a topic (recent topics, remembered duration) is a top-1 lookup on
-- (user_id, topic_id) ordered by started_at DESC, id DESC. The old (user_id, topic_id) index
-- made it read every session of the topic; this one seeks straight to it (read backwards), and
-- its prefix still serves the foreign key to topics, so it replaces the old index.

-- DropIndex
DROP INDEX "focus_sessions_user_id_topic_id_idx";

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_topic_id_started_at_id_idx" ON "focus_sessions"("user_id", "topic_id", "started_at", "id");
