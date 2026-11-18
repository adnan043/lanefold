-- Chat: an edit counter per conversation, and two indexes that only cost writes.
--
-- 1. `conversations.edit_rev` moves on every change the `after` poll cannot see (an edit, a delete, a reaction, a pin,
--    a card linked to a message, a new reply under a message). The pulse returns it, so an open chat re-reads its newest
--    window only when something changed instead of every 20 seconds.
-- 2. `messages(conversation_id, parent_id, id)`: paging moved to `seq`; `(conversation_id, parent_id, seq)` serves every read.
-- 3. `message_reactions`: since one reaction per person, `(message_id, user_id)` is the key; the 3-column key duplicated it.
BEGIN;

ALTER TABLE "conversations" ADD COLUMN "edit_rev" BIGINT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "messages_conversation_id_parent_id_id_idx";

ALTER TABLE "message_reactions" DROP CONSTRAINT "message_reactions_pkey";
DROP INDEX "message_reactions_message_id_user_id_key";
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id", "user_id");

COMMIT;
