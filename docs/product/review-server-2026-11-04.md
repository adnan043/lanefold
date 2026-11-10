# Server review 2026-11-04 (members, notifications, export, review7 test)

Review: 6 routes checked (GET/DELETE members, POST leave, GET unread-count, GET export.json/csv) plus the review7 test.

Authorization
- DELETE /workspaces/:id/members/:userId: requireAuth + requireWorkspaceRole("admin"); target read via membership(workspaceId, targetId), 404 if absent; canManageMember (no owner removal, admin only below admin); the delete itself is `deleteMany {workspaceId, userId, role}` under the workspace row lock, so a role change in between gives 404 not a wrong delete. Self-removal refused (409, use leave). Leave: last-owner check inside the same transaction (rolls back).
- GET members: maskEmail only for admin/owner; short local parts (<=3) show no letter; domain masked. No full address anywhere.
- GET unread-count: user_id in the query; bound params only.
- Export: boardAccess + canAdmin (404 for outsiders, 403 for non-admin), workspace_id AND board_id in the card query, rate limit 20/h from audit events, 5000-card cap, names only (no emails), attachments name+url of ready files only.
- Raw SQL: all tagged, Prisma.join / Prisma.sql, no Unsafe/raw.

Keyset correctness
- Export row comparison (lane.position, lane.id, card.position, card.id) matches ORDER BY exactly (strict total order, so no skips or duplicates at ties). Positions are COLLATE "C" columns; FIXED: the cursor params now carry explicit `::text COLLATE "C"` / `::int` casts (as boards.ts cardsAfter does) so the comparison cannot depend on parameter typing/collation.
- Lanes list (200 cap) is ordered the same way (position, id) as the SQL, so lane open/close events stay in step.

Unread count
- Counts the newest 500 unread rows, then visibility, so it can undercount only when more than 500 newer unread rows are hidden/unreachable; the badge shows up to 99. Acceptable (hidden rows are deleted on leaving a workspace). Left as is.

Security found and fixed
- boards.ts moveBody: afterId accepted any safe integer; a value above int4 would reach Prisma `id: afterId` and 500. Now capped at 2_147_483_647 (422 above).

Test (review7-server.test.ts)
- Verified the stale path: unknown afterId -> keyAfter returns 'stale' in the pre-check -> 409 `{error:'stale'}` before the board lock/rev bump. Test now asserts exactly 409 + code, plus afterId 99999999999 -> 422, and rev unchanged. Not run (per instructions).

Performance
- Export: per 100-card batch 1 card query + 5 parallel child reads + 1 name read (3 sequential round trips); max 50 batches. The row comparison cannot use the (workspace, lane, position, id) index as a range, so each batch re-sorts the board's cards: bounded by board size (lane cap), fine at current scale.
- Unread count: one query, scan capped at 500.
- members delete: lock + deleteMany + updateMany + insert + 4 parallel deletes in one transaction.

Left open (minor)
- Export reports truncated=true when a board has exactly 5000 cards (no probe row). Harmless.
- Export rate limit counts audit rows written before streaming; concurrent requests could slightly exceed 20/h.
