BEGIN;

-- Thread and top-level pages keyset on seq: WHERE conversation_id = ? AND parent_id [IS NULL | = ?] AND seq </> ? ORDER BY seq.
CREATE INDEX IF NOT EXISTS "messages_conversation_id_parent_id_seq_idx" ON "messages"("conversation_id", "parent_id", "seq");

COMMIT;
