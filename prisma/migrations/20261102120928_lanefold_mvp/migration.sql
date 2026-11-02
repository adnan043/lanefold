-- Lanefold MVP tables (docs/product/SPEC.md §6). One transaction: all or nothing.
BEGIN;

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "locale" VARCHAR(8) NOT NULL DEFAULT 'en',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "first_day_of_week" INTEGER NOT NULL DEFAULT 1,
    "theme_mode" VARCHAR(10) NOT NULL DEFAULT 'system',
    "accent_hex" VARCHAR(7) NOT NULL DEFAULT '#5B5BD6',
    "density" VARCHAR(12) NOT NULL DEFAULT 'comfortable',
    "font_scale" INTEGER NOT NULL DEFAULT 100,
    "radius" VARCHAR(8) NOT NULL DEFAULT 'soft',
    "reduce_motion" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "plan" VARCHAR(16) NOT NULL DEFAULT 'free',
    "member_limit" INTEGER NOT NULL DEFAULT 10,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "brand_accent_hex" VARCHAR(7),
    "enforce_theme" BOOLEAN NOT NULL DEFAULT false,
    "default_locale" VARCHAR(8) NOT NULL DEFAULT 'en',
    "grace_until" TIMESTAMPTZ(3),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "email_hash" VARCHAR(64),
    "role" VARCHAR(10) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_join_links" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "role" VARCHAR(10) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "max_uses" INTEGER NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspace_join_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boards" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "visibility" VARCHAR(10) NOT NULL DEFAULT 'workspace',
    "bg_kind" VARCHAR(10) NOT NULL DEFAULT 'color',
    "bg_color_1" VARCHAR(7) NOT NULL DEFAULT '#F4F4F5',
    "bg_color_2" VARCHAR(7) NOT NULL DEFAULT '#E7E5E4',
    "bg_angle" INTEGER NOT NULL DEFAULT 135,
    "bg_pattern" VARCHAR(16) NOT NULL DEFAULT 'none',
    "bg_file_id" VARCHAR(32),
    "share_token_hash" VARCHAR(64),
    "rev" BIGINT NOT NULL DEFAULT 0,
    "inbox_of" INTEGER,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_members" (
    "board_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "role" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_members_pkey" PRIMARY KEY ("board_id","user_id")
);

-- CreateTable
CREATE TABLE "board_stars" (
    "user_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_stars_pkey" PRIMARY KEY ("user_id","board_id")
);

-- CreateTable
CREATE TABLE "lanes" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "position" VARCHAR(64) NOT NULL,
    "color_hex" VARCHAR(7),
    "wip_limit" INTEGER,
    "card_count" INTEGER NOT NULL DEFAULT 0,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "updated_rev" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lanes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "lane_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description_md" VARCHAR(20000) NOT NULL DEFAULT '',
    "position" VARCHAR(64) NOT NULL,
    "priority" VARCHAR(8) NOT NULL DEFAULT 'none',
    "estimate_minutes" INTEGER,
    "start_date" DATE,
    "due_date" DATE,
    "completed_at" TIMESTAMPTZ(3),
    "cover_file_id" VARCHAR(32),
    "checklist_total" INTEGER NOT NULL DEFAULT 0,
    "checklist_done" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "updated_rev" BIGINT NOT NULL DEFAULT 0,
    "import_id" VARCHAR(40),
    "external_id" VARCHAR(64),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_members" (
    "card_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_members_pkey" PRIMARY KEY ("card_id","user_id")
);

-- CreateTable
CREATE TABLE "card_watchers" (
    "card_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_watchers_pkey" PRIMARY KEY ("card_id","user_id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "color_hex" VARCHAR(7) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_labels" (
    "card_id" INTEGER NOT NULL,
    "label_id" INTEGER NOT NULL,

    CONSTRAINT "card_labels_pkey" PRIMARY KEY ("card_id","label_id")
);

-- CreateTable
CREATE TABLE "checklists" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "position" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" SERIAL NOT NULL,
    "checklist_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "position" VARCHAR(64) NOT NULL,
    "done_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "author_id" INTEGER NOT NULL,
    "body_md" VARCHAR(5000) NOT NULL,
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_mentions" (
    "comment_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("comment_id","user_id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "card_id" INTEGER,
    "message_id" BIGINT,
    "file_id" VARCHAR(32),
    "url" VARCHAR(500),
    "name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(127) NOT NULL DEFAULT '',
    "size" INTEGER NOT NULL DEFAULT 0,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_links" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "card_id" INTEGER NOT NULL,
    "linked_card_id" INTEGER NOT NULL,
    "kind" VARCHAR(10) NOT NULL DEFAULT 'relates',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER,
    "card_id" INTEGER,
    "actor_id" INTEGER NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "actor_id" INTEGER,
    "board_id" INTEGER,
    "card_id" INTEGER,
    "conversation_id" INTEGER,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_filters" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "filter" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "board_id" INTEGER,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(80),
    "dm_key" VARCHAR(24),
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "muted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "seq" BIGINT NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "body_md" VARCHAR(4000) NOT NULL,
    "parent_id" BIGINT,
    "client_id" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(8) NOT NULL DEFAULT 'user',
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "pinned_at" TIMESTAMPTZ(3),
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "message_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id","user_id","emoji")
);

-- CreateTable
CREATE TABLE "message_mentions" (
    "message_id" BIGINT NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "message_card_refs" (
    "message_id" BIGINT NOT NULL,
    "card_id" INTEGER NOT NULL,

    CONSTRAINT "message_card_refs_pkey" PRIMARY KEY ("message_id","card_id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" INTEGER NOT NULL,
    "billing_mode" VARCHAR(12) NOT NULL DEFAULT 'PAID',
    "grace_days" INTEGER NOT NULL DEFAULT 14,
    "maintenance_message" VARCHAR(300) NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_limits" (
    "plan" VARCHAR(16) NOT NULL,
    "max_members" INTEGER NOT NULL,
    "max_file_bytes" BIGINT NOT NULL,
    "storage_quota_bytes" BIGINT NOT NULL,
    "max_flows" INTEGER NOT NULL DEFAULT 0,
    "price_key_monthly" VARCHAR(63) NOT NULL DEFAULT '',
    "audit_log" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_limits_pkey" PRIMARY KEY ("plan")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_workspace_id_idx" ON "workspace_members"("user_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_token_hash_key" ON "workspace_invites"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invites_workspace_id_id_idx" ON "workspace_invites"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_join_links_token_hash_key" ON "workspace_join_links"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_join_links_workspace_id_id_idx" ON "workspace_join_links"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "boards_share_token_hash_key" ON "boards"("share_token_hash");

-- CreateIndex
CREATE INDEX "boards_workspace_id_archived_at_id_idx" ON "boards"("workspace_id", "archived_at", "id");

-- CreateIndex
CREATE INDEX "boards_inbox_of_workspace_id_idx" ON "boards"("inbox_of", "workspace_id");

-- CreateIndex
CREATE INDEX "board_members_user_id_workspace_id_idx" ON "board_members"("user_id", "workspace_id");

-- CreateIndex
CREATE INDEX "board_stars_board_id_idx" ON "board_stars"("board_id");

-- CreateIndex
CREATE INDEX "lanes_workspace_id_board_id_position_id_idx" ON "lanes"("workspace_id", "board_id", "position", "id");

-- CreateIndex
CREATE INDEX "lanes_board_id_updated_rev_idx" ON "lanes"("board_id", "updated_rev");

-- CreateIndex
CREATE INDEX "cards_workspace_id_lane_id_position_id_idx" ON "cards"("workspace_id", "lane_id", "position", "id");

-- CreateIndex
CREATE INDEX "cards_board_id_updated_rev_idx" ON "cards"("board_id", "updated_rev");

-- CreateIndex
CREATE INDEX "cards_workspace_id_due_date_id_idx" ON "cards"("workspace_id", "due_date", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cards_board_id_import_id_external_id_key" ON "cards"("board_id", "import_id", "external_id");

-- CreateIndex
CREATE INDEX "card_members_user_id_workspace_id_card_id_idx" ON "card_members"("user_id", "workspace_id", "card_id");

-- CreateIndex
CREATE INDEX "card_watchers_user_id_card_id_idx" ON "card_watchers"("user_id", "card_id");

-- CreateIndex
CREATE INDEX "labels_workspace_id_board_id_id_idx" ON "labels"("workspace_id", "board_id", "id");

-- CreateIndex
CREATE INDEX "card_labels_label_id_card_id_idx" ON "card_labels"("label_id", "card_id");

-- CreateIndex
CREATE INDEX "checklists_workspace_id_card_id_position_id_idx" ON "checklists"("workspace_id", "card_id", "position", "id");

-- CreateIndex
CREATE INDEX "checklist_items_workspace_id_checklist_id_position_id_idx" ON "checklist_items"("workspace_id", "checklist_id", "position", "id");

-- CreateIndex
CREATE INDEX "comments_workspace_id_card_id_id_idx" ON "comments"("workspace_id", "card_id", "id");

-- CreateIndex
CREATE INDEX "comments_author_id_created_at_idx" ON "comments"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "comment_mentions_user_id_comment_id_idx" ON "comment_mentions"("user_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_file_id_key" ON "attachments"("file_id");

-- CreateIndex
CREATE INDEX "attachments_workspace_id_card_id_id_idx" ON "attachments"("workspace_id", "card_id", "id");

-- CreateIndex
CREATE INDEX "attachments_workspace_id_message_id_id_idx" ON "attachments"("workspace_id", "message_id", "id");

-- CreateIndex
CREATE INDEX "attachments_uploaded_by_created_at_idx" ON "attachments"("uploaded_by", "created_at");

-- CreateIndex
CREATE INDEX "card_links_workspace_id_linked_card_id_idx" ON "card_links"("workspace_id", "linked_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_links_card_id_linked_card_id_kind_key" ON "card_links"("card_id", "linked_card_id", "kind");

-- CreateIndex
CREATE INDEX "activity_workspace_id_board_id_id_idx" ON "activity"("workspace_id", "board_id", "id" DESC);

-- CreateIndex
CREATE INDEX "activity_workspace_id_card_id_id_idx" ON "activity"("workspace_id", "card_id", "id" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_id_idx" ON "notifications"("user_id", "id" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_id_idx" ON "notifications"("user_id", "read_at", "id");

-- CreateIndex
CREATE INDEX "saved_filters_user_id_board_id_id_idx" ON "saved_filters"("user_id", "board_id", "id");

-- CreateIndex
CREATE INDEX "saved_filters_board_id_id_idx" ON "saved_filters"("board_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_board_id_key" ON "conversations"("board_id");

-- CreateIndex
CREATE INDEX "conversations_workspace_id_kind_id_idx" ON "conversations"("workspace_id", "kind", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_dm_key_key" ON "conversations"("workspace_id", "dm_key");

-- CreateIndex
CREATE INDEX "conversation_members_user_id_workspace_id_conversation_id_idx" ON "conversation_members"("user_id", "workspace_id", "conversation_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_parent_id_id_idx" ON "messages"("conversation_id", "parent_id", "id");

-- CreateIndex
CREATE INDEX "messages_sender_id_created_at_idx" ON "messages"("sender_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_id_key" ON "messages"("conversation_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE INDEX "message_mentions_user_id_message_id_idx" ON "message_mentions"("user_id", "message_id");

-- CreateIndex
CREATE INDEX "message_card_refs_card_id_message_id_idx" ON "message_card_refs"("card_id", "message_id");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stars" ADD CONSTRAINT "board_stars_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_lane_id_fkey" FOREIGN KEY ("lane_id") REFERENCES "lanes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_members" ADD CONSTRAINT "card_members_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_watchers" ADD CONSTRAINT "card_watchers_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_labels" ADD CONSTRAINT "card_labels_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_labels" ADD CONSTRAINT "card_labels_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_card_refs" ADD CONSTRAINT "message_card_refs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- position columns sort by bytes (fractional-indexing keys)
ALTER TABLE "lanes" ALTER COLUMN "position" TYPE VARCHAR(64) COLLATE "C";
ALTER TABLE "cards" ALTER COLUMN "position" TYPE VARCHAR(64) COLLATE "C";
ALTER TABLE "checklists" ALTER COLUMN "position" TYPE VARCHAR(64) COLLATE "C";
ALTER TABLE "checklist_items" ALTER COLUMN "position" TYPE VARCHAR(64) COLLATE "C";

-- small fixed sets
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_check" CHECK ("role" IN ('owner','admin','member','viewer'));
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_role_check" CHECK ("role" IN ('admin','member','viewer'));
ALTER TABLE "workspace_join_links" ADD CONSTRAINT "workspace_join_links_role_check" CHECK ("role" IN ('admin','member','viewer'));
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_role_check" CHECK ("role" IN ('admin','member','viewer'));
ALTER TABLE "boards" ADD CONSTRAINT "boards_visibility_check" CHECK ("visibility" IN ('private','workspace','public'));
ALTER TABLE "boards" ADD CONSTRAINT "boards_bg_kind_check" CHECK ("bg_kind" IN ('color','gradient','pattern','image'));
ALTER TABLE "cards" ADD CONSTRAINT "cards_priority_check" CHECK ("priority" IN ('none','low','medium','high','urgent'));
ALTER TABLE "card_links" ADD CONSTRAINT "card_links_kind_check" CHECK ("kind" IN ('relates','blocks','duplicates'));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_check" CHECK ("kind" IN ('dm','group','channel','board'));
ALTER TABLE "messages" ADD CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('user','system'));
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_theme_check" CHECK ("theme_mode" IN ('light','dark','system','contrast'));
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_density_check" CHECK ("density" IN ('compact','comfortable','spacious'));
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_radius_check" CHECK ("radius" IN ('sharp','soft','round'));
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_billing_mode_check" CHECK ("billing_mode" IN ('FREE_FOR_ALL','PAID'));
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_single_row_check" CHECK ("id" = 1);
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_counts_check" CHECK ("member_count" >= 0 AND "storage_used_bytes" >= 0);
ALTER TABLE "lanes" ADD CONSTRAINT "lanes_counts_check" CHECK ("card_count" >= 0);

-- Only one personal Inbox per user and workspace-less lookups stay cheap
CREATE UNIQUE INDEX "boards_inbox_of_key" ON "boards" ("inbox_of") WHERE "inbox_of" IS NOT NULL;

-- Seed: settings row and the three flat plans (editable in /dashboard)
INSERT INTO "app_settings" ("id", "billing_mode", "grace_days", "maintenance_message", "updated_at") VALUES (1, 'PAID', 14, '', CURRENT_TIMESTAMP);
INSERT INTO "plan_limits" ("plan","max_members","max_file_bytes","storage_quota_bytes","max_flows","price_key_monthly","audit_log","updated_at") VALUES
 ('free', 10, 10485760, 1073741824, 0, '', false, CURRENT_TIMESTAMP),
 ('pro', 50, 104857600, 21474836480, 10, 'pro-monthly', false, CURRENT_TIMESTAMP),
 ('team', 100, 104857600, 107374182400, 100, 'team-monthly', true, CURRENT_TIMESTAMP);

COMMIT;
