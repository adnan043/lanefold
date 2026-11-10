# Privacy audit (read-only)

Scope: src/server/**, src/app/**, prisma/schema.prisma, scripts/seed-demo.ts, headers. No code changed.

## P1: Delete account leaves all Lanefold data behind (HIGH, CONFIRMED)
- `src/platform/auth/security-routes.ts:466` runs only `db.user.delete`. It cascades only the auth tables (user_roles, refresh_tokens, password_resets, email_verifications, sign_in_codes, email_changes, recovery_codes).
- None of the product tables has a FK to `users` (prisma/schema.prisma:411-931). These rows survive with the dead `user_id`:
  - Membership and workspace: user_profiles (:411), workspace_members (:458), workspaces.created_by (:444), workspace_invites.created_by (:481), join_links.created_by (:500)
  - Boards and cards: board_members (:547), board_stars (:561), boards.created_by (:529), cards.created_by (:620), card_members (:642), card_watchers (:655)
  - Comments and mentions: comments.author_id (:730), comment_mentions (:746)
  - Activity, notifications, filters: activity.actor_id (:800), notifications.user_id / actor_id (:813-817), saved_filters (:831)
  - Chat: conversations.created_by (:855), conversation_members (:869), messages (sender, :882-), message_reactions (:914), message_mentions (:926)
  - Money and audit: orders.user_id / email and memberships.user_id / email (:333, :357), audit_events.actor_id
- Effects:
  - Messages, comments and activity text stay in other people's workspaces. The user's profile row and board stars stay too. "Deleted user" is only a client-side fallback.
  - `workspaces.memberCount` stays stale, and a sole-owner workspace becomes ownerless but keeps its data and its billing.
  - `user_profiles` keeps the timezone and locale of a deleted user.
  - Uploaded files (attachments, covers) are not deleted when their uploader is deleted.
- Fix: do not edit src/platform. Add an app-side step before the platform delete.
  - Option A: add the real FKs through a migration, `onDelete: Cascade` for personal rows (profile, members, stars, saved_filters, notifications, watchers, reactions, mentions) and `SetNull` or a tombstone for authored content.
  - Option B: a `deleteUserData(userId)` job. It transfers or blocks sole-owner workspaces, deletes personal rows, nulls `orders.email`, and deletes the user's files through the files API.
  - Whichever you pick, adopt a documented policy for messages and comments (anonymise or remove).

## P2: Orders and memberships copy the buyer email (MEDIUM, CONFIRMED)
- `src/server/payments-hooks.ts:46` and `:84` store `email` lower-cased in `orders` and `memberships`, with `@@index([email, ...])`. AGENTS.md says never copy emails into your own tables.
- They are also read back by email (`memberships.ts:26`, `checkout.ts:233`). That helps guest checkouts, but it is retained after account deletion (schema comment says the order outlives the account).
- Fix: keep the row but null `email` when `userId` is set. For guests keep it only until the claim window ends. Null it on account deletion (see P1).

## P3: Masked email leaks the domain and the first letter (LOW to MEDIUM, CONFIRMED)
- `src/server/routes/members.ts:70-73` returns `m•••@gmail.com`, served to admins and owners in the directory (`:207-219`).
- It reveals the full domain, which for a company domain exposes the employer. Combined with the name it is nearly identifying.
- The admin already has the user's name. If the point is to tell apart two members with the same name, the domain is unneeded.
- Fix: show `m•••@••••.com` (TLD only), or only the domain when it is on a free-mail list. Better still, drop the field unless the UI really needs it.
- Also, the `take: PAGE` user query at `:207` selects the full `email` into memory. That is fine, but select only what is needed if the mask is dropped.

## P4: Error logging may carry personal data (LOW, SUSPECTED)
- `src/server/app.ts:103`, `src/server/notifications.ts:78` and `src/server/routes/checkout.ts:215` log `err.message`.
- Prisma error messages can embed `where` values, for example an email in `findUnique({where:{email}})` failures, and the invite and checkout code paths include ids.
- Fix: log `err.name` plus a Prisma `code` and `meta.target` only, or run messages through a scrubber that drops quoted values.

## P5: Join and invite token in the URL (LOW, CONFIRMED but mitigated)
- `/app/join/<token>` (`src/app/routes.tsx:127-131`) puts a bearer token in the path. Tokens are stored only as SHA-256 (`members.ts:382`) and shown once. Acceptance needs a signed-in POST and is rate-limited. Those parts are good.
- Referrer: `src/platform/headers.ts:20` and `public/_headers:6` set `strict-origin-when-cross-origin`. That sends only the origin cross-origin, so the token does not leak to third parties. The join page links out nowhere, so this is okay.
- Gap: the token stays in browser history and in the Worker and CDN access logs. After accept or failure, call `history.replaceState` to drop the token from the URL.
- Optionally add `Referrer-Policy: no-referrer` on `/app/join/*` as defence in depth. `Base.astro:111` already does this for `secretInUrl`, but check that the App layout does too.

## P6: Audit and activity payloads (LOW, CONFIRMED, clean)
- Audit `meta` holds ids and roles only (`members.ts:245,262,329,385`). The invite email is stored only as a SHA-256 (`emailHash`) and `bound: true`. Note that an unsalted SHA-256 of an email is guessable from a candidate list. Fix: use an HMAC keyed with `JWT_SECRET`, or compare in the route instead.
- `activity.meta` holds names and titles of boards, lanes and cards (`boards.ts:599,799,918`). It is content, not PII, but it is never removed with the user. Covered by P1.
- The `workspace.member.removed` and `role_changed` audit rows keep `userId` after deletion. That is acceptable as a log but is not deleted either.

## P7: Clean areas (no finding)
- Every users `select` I traced returns names only: `card-faces.ts`, `card-detail.ts:363,543`, `chat-extras.ts:76`, `search.ts`, `notifications.ts` and `chat.ts`. The only email select in a response path is the members directory (P3).
- `checkout.ts:98` hides email, metadata and customerRef from the browser.
- localStorage holds UI prefs, lane collapse state, setup-checklist flags and the workspace id (`prefs.ts`, `lane.tsx`, `setup-checklist.tsx`, `workspace.tsx`). No tokens or emails.
- Cache: `delPrefix(userKey(...))` at deletion. I did not find email in cache keys under src/server.
- Seed `scripts/seed-demo.ts`: refuses non-localhost, creates no users, and masks the email in the dry-run output (`:100`). Fine.
- No analytics was found in src/app or src/server.

## Top actions
1. P1 (a migration or a cleanup hook for account deletion).
2. P2 (stop keeping the buyer email).
3. P3 (drop the domain from the mask).
4. P5 (remove the token from the URL after use).
5. P4 (scrub the logs).
