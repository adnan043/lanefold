-- Optional expiry of a board's public link (/b/<token>/). NULL = never expires. Additive and safe to repeat.
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "share_expires_at" TIMESTAMPTZ(3);
