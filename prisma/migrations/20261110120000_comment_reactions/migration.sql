BEGIN;

-- Emoji reactions on card comments (like chat's message_reactions). Expand-only: a new table the old code never reads.
CREATE TABLE "comment_reactions" (
    "comment_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("comment_id", "user_id", "emoji")
);

CREATE INDEX "comment_reactions_user_id_idx" ON "comment_reactions"("user_id");

ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A deleted account takes its reactions with it.
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_emoji_check" CHECK (char_length("emoji") BETWEEN 1 AND 16);

COMMIT;
