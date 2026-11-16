# Review 9: full security check, whole site (2026-11-16)

Scope: every route in `src/server/routes`, the access helpers, jobs and flows, pages, layouts, the client (`src/app`, `src/portal`),
CSP/headers and dependencies, as on disk (including the uncommitted performance work). Five independent passes
(boards and sharing; cards, search and files; chat and notifications; members, billing and import/export; flows, jobs,
pages and config), each finding then checked in the code. `npm audit --omit=dev`: 0 vulnerabilities.

No critical or high issue found. Object-level checks (ids in the URL or body), function-level checks (viewer, guest, member,
admin), private chats, notification ownership, email privacy, payment hooks, share tokens and XSS sinks all held.

## Fixed (tests: `tests/integration/security-audit-2026-11.test.ts`)
- **Access could not be cut while a workspace was read-only.** Revoking a public link, archiving, making a board private,
  removing a seat and withdrawing an invite or invite link all answered 409. Now a `revoke` need (`boards.ts`) skips the
  read-only and archived gates for these; granting (share, restore, other edits) stays blocked.
- **Archiving kept the public link.** Restoring the board brought a leaked token back. Archive now clears the share hash
  (and `public` → `workspace`), as revoking does.
- **A guest a board admin removed could rejoin with the same board invite link.** New `board_removals` table (migration
  `20261116130000_board_removals`): the link, or an invite made before the removal, no longer seats them; a newer invite or an
  admin re-adding them lifts it. Leaving on your own does not bar you.
- **Guest cap raced.** Parallel accepts each passed the count before any insert. The deciding count now runs inside the
  transaction under the workspace row lock (`board-seats.ts`).
- **Hourly board cap raced** (create and duplicate; a duplicate copies up to 1000 cards). Deciding count now inside the
  transaction under a per-user advisory lock (`boardCapReached`).
- **Any board writer could rename someone else's attachment** (delete already needed uploader or board admin). Rename now
  matches delete; the client hides the menu item.
- **A member could fill all 50 channel slots** (channels cannot be deleted). Members (not admins) start at most 5 an hour
  and 10 in all.
- **Unbounded bulk writes.** Per-user hourly soft limits: lane copy 30, Trello import chunks 300, timed reminder jobs 120
  (past the budget the hourly run still reminds).

## Left open (low, product decisions)
- Link attachments and imported links accept `http:` (not `javascript:`/`data:`); security.md prefers https only.
- Board invite by email answers `added`/`already` for a workspace member's address vs `invited` otherwise (known,
  rate limited and audited).
- Guests can list workspace member names (no emails) through the people pickers.
- Another admin can resend a failed invite if they know its address (by design; gives nothing beyond inviting).
- `@all` is open to every channel writer, and the per-recipient hourly notification cap is shared by all senders.
- Notification-email tallies do not apply the in-app visibility filter (counts only, no content leaks).
- `GET /boards/:id/conversation` creates the board chat row on a GET.
- No route deletes or archives a channel.
- Approximate (cache-based) limits: public board view counter, comment rate limit, recurrence rule cap across boards.
- Ownership transfer has no typed confirmation or email (owner-only, CSRF-protected).
