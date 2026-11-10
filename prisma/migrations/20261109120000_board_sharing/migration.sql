BEGIN;

-- Board sharing ("Share"): who may add people, self-join, an invite link, and board invites (guests) on workspace_invites.
-- Expand-only: new nullable / defaulted columns and a widened CHECK, safe for the code that runs before this deploy.

ALTER TABLE "boards" ADD COLUMN "member_invites" VARCHAR(10) NOT NULL DEFAULT 'admins',
  ADD COLUMN "self_join" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "invite_link_hash" VARCHAR(64),
  ADD COLUMN "invite_link_role" VARCHAR(10),
  ADD COLUMN "invite_link_by" INTEGER;

ALTER TABLE "boards" ADD CONSTRAINT "boards_member_invites_check" CHECK ("member_invites" IN ('admins', 'members'));
ALTER TABLE "boards" ADD CONSTRAINT "boards_invite_link_role_check"
  CHECK ("invite_link_role" IS NULL OR "invite_link_role" IN ('member', 'viewer'));

CREATE UNIQUE INDEX "boards_invite_link_hash_key" ON "boards"("invite_link_hash");
CREATE INDEX "boards_invite_link_by_idx" ON "boards"("invite_link_by");

-- Guests: seats of people who are not workspace members, counted per workspace.
CREATE INDEX "board_members_workspace_id_user_id_idx" ON "board_members"("workspace_id", "user_id");

ALTER TABLE "workspace_invites" ADD COLUMN "board_id" INTEGER,
  ADD COLUMN "board_role" VARCHAR(10);
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "workspace_invites_board_id_idx" ON "workspace_invites"("board_id");
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_board_role_check"
  CHECK ("board_role" IS NULL OR "board_role" IN ('admin', 'member', 'viewer'));

-- `guest` only together with a board.
ALTER TABLE "workspace_invites" DROP CONSTRAINT "workspace_invites_role_check";
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_role_check"
  CHECK ("role" IN ('admin', 'member', 'viewer', 'guest') AND ("role" <> 'guest' OR "board_id" IS NOT NULL));

COMMIT;
