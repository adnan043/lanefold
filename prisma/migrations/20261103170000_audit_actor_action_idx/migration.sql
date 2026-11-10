BEGIN;

-- Export rate limit: WHERE actor_user_id = ? AND action = 'board.exported' AND created_at > ? ORDER BY id DESC LIMIT n.
CREATE INDEX IF NOT EXISTS "audit_events_actor_user_id_action_id_idx" ON "audit_events"("actor_user_id", "action", "id" DESC);

COMMIT;
